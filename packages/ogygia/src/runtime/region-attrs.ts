/**
 * DOM attribute vocabulary for `<ogygia-region>` (DESIGN.md two axes).
 *
 * - `wake`    — when JS wakes: `none` | `load` | `idle` | `visible` | `interaction` | media query
 * - `render`  — when HTML arrives: omit/`page` | `defer`
 * - `when`    — schedule for `render="defer"` OR `remount="swr"` revalidate
 * - `hydrate-margin` — IntersectionObserver rootMargin for phase-2 `wake="visible"`
 * - `remount` — `{#if}` re-creation of `wake="none"`: `cache` | `empty` | `swr`
 * - `max-age` — client lake-cache TTL in ms (optional)
 * - `on-expire` — past max-age: `empty` | `fetch` (swr default `fetch`, cache default `empty`)
 *
 * No "island" / "lake" attribute names — those are nicknames, not the mechanism.
 */

/** CSS selector for frozen regions (`hydrate: 'none'`). */
export const FROZEN_SELECTOR = 'ogygia-region[wake="none"]';

/** True if this region is a wake boundary (JS will / did run for its subtree). */
export function is_awake(el: Element): boolean {
	const h = el.getAttribute('wake');
	return h != null && h !== 'none';
}

/** True if this region freezes its subtree (SSR DOM preserved; no client module). */
export function is_frozen(el: Element): boolean {
	return el.getAttribute('wake') === 'none';
}

/** True if this region fetches HTML later (`render="defer"`). */
export function is_deferred(el: Element): boolean {
	return el.getAttribute('render') === 'defer';
}

/** `{#if}` remount policy for `wake="none"` regions. Default `cache`. */
export function region_remount(el: Element): 'cache' | 'empty' | 'swr' {
	const r = el.getAttribute('remount');
	if (r === 'empty' || r === 'swr') return r;
	return 'cache';
}

/** Client lake-cache TTL in ms from `max-age`. `0` = no expiry. */
export function region_max_age_ms(el: Element): number {
	const raw = el.getAttribute('max-age');
	if (raw == null || raw === '') return 0;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Past-maxAge behavior. Defaults: `cache` → `empty`, `swr` → `fetch`.
 * `fetch` is only meaningful with `remount="swr"` (endpoint present).
 */
export function region_on_expire(el: Element): 'empty' | 'fetch' {
	const raw = el.getAttribute('on-expire');
	if (raw === 'empty' || raw === 'fetch') return raw;
	return region_remount(el) === 'swr' ? 'fetch' : 'empty';
}

/**
 * True when a frozen region has only Svelte placeholder anchors (comments / whitespace).
 * Used by remount: a text-only lake is still "filled" — `querySelector('*')` would miss it and
 * double-append the cache on reconnect (REMOUNT-VACANT).
 */
export function region_is_vacant(el: ParentNode): boolean {
	for (const n of el.childNodes) {
		if (n.nodeType === 1) return false; // Element
		if (n.nodeType === 3 && (n.textContent?.trim() ?? '') !== '') return false; // Text
	}
	return true;
}

/** True when this document was SERVED FROM the freeze store (the handle stamps hit/join
 *  copies with a head meta). A stored copy is a cached render by definition — swr lakes read
 *  this to revalidate on FIRST mount, not only on remounts. */
export function document_is_freeze(): boolean {
	return typeof document !== 'undefined' && !!document.querySelector('meta[name="ogygia-freeze"]');
}

/**
 * True when the browser's HTML parser tore this placed island's SSR content OUT of the region —
 * the invalid-nesting hoist.
 *
 * A block-rendering island authored INLINE inside a `<p>` (e.g. a `<Counter/>` sitting in a markdown
 * sentence, where the component renders `<div>…</div>`) is invalid HTML: a `<div>` start tag while a
 * `<p>` is in button scope makes the parser CLOSE the paragraph, popping this `<ogygia-region>` with
 * it — the region is left holding only its opening Svelte hydration anchors (`<!--[-->`), while the
 * rendered nodes (and the closing anchors) become siblings of the paragraph. Hydrating that empty
 * region then fresh-mounts a SECOND copy, and the hoisted server copy lingers as an orphan → the
 * page shows the island twice.
 *
 * Detected as an UNBALANCED hydration envelope: strictly more `[` open anchors than `]` close anchors
 * among the region's descendants. A validly-nested region (inline content, or block content in block
 * context) always balances; a region that renders nothing balances (0 == 0); a not-yet-swapped
 * deferred/live region carries no anchors at all (0 == 0). So this never false-positives on a
 * correctly-parsed region — only the parser-truncated envelope reads open > close.
 */
export function region_ssr_truncated(el: ParentNode): boolean {
	let open = 0;
	let close = 0;
	const scan = (parent: ParentNode) => {
		for (const n of parent.childNodes) {
			if (n.nodeType === 8) {
				// Comment: Svelte 5 fragment anchors are `<!--[-->` / `<!--[N-->` (open) and `<!--]-->`
				// (close). Read the first non-space char of the comment data.
				const d = (n.textContent ?? '').trim();
				if (d[0] === '[') open++;
				else if (d[0] === ']') close++;
			} else if (n.nodeType === 1) {
				scan(n as unknown as ParentNode);
			}
		}
	};
	scan(el);
	return open > close;
}

/**
 * Schedule string for the shared scheduler.
 * Deferred regions use `when`; waking regions use `wake`; default `load`.
 */
export function region_schedule(el: Element): string {
	if (is_deferred(el)) return el.getAttribute('when') || 'load';
	const h = el.getAttribute('wake');
	if (h && h !== 'none') return h;
	return 'load';
}

/**
 * Wake schedule from `wake`, or `null` when this region does not run JS
 * (`wake` absent / `'none'`). Used after a deferred HTML swap for phase 2.
 */
export function region_hydrate_schedule(el: Element): string | null {
	const h = el.getAttribute('wake');
	if (h == null || h === 'none') return null;
	return h;
}

/**
 * Phase-2 (post-swap) hydrate schedule for a deferred client island.
 *
 * - Matching schedules (`load`/`load`, `idle`/`idle`, `visible`/`visible`, same media) → `'load'`
 *   (hydrate immediately; do not re-arm the same idle / IO / MQ).
 * - `hydrate: 'load'` after any defer → `'load'` (ASAP after swap).
 * - Otherwise arm hydrate’s own schedule only.
 */
export function phase2_hydrate_schedule(defer_when: string, hydrate: string): string {
	if (hydrate === 'load' || hydrate === defer_when) return 'load';
	return hydrate;
}
