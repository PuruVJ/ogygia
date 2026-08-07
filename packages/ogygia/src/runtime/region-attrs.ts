/**
 * DOM attribute vocabulary for `<ogygia-region>` (DESIGN.md two axes).
 *
 * - `hydrate` — when JS wakes: `none` | `load` | `idle` | `visible` | media query
 * - `render`  — when HTML arrives: omit/`page` | `defer`
 * - `when`    — schedule for `render="defer"` OR `remount="swr"` revalidate
 * - `hydrate-margin` — IntersectionObserver rootMargin for phase-2 `hydrate="visible"`
 * - `remount` — `{#if}` re-creation of `hydrate="none"`: `cache` | `empty` | `swr`
 * - `max-age` — client lake-cache TTL in ms (optional)
 * - `on-expire` — past max-age: `empty` | `fetch` (swr default `fetch`, cache default `empty`)
 *
 * No "island" / "lake" attribute names — those are nicknames, not the mechanism.
 */

/** CSS selector for frozen regions (`hydrate: 'none'`). */
export const FROZEN_SELECTOR = 'ogygia-region[hydrate="none"]';

/** True if this region is a wake boundary (JS will / did run for its subtree). */
export function is_awake(el: Element): boolean {
	const h = el.getAttribute('hydrate');
	return h != null && h !== 'none';
}

/** True if this region freezes its subtree (SSR DOM preserved; no client module). */
export function is_frozen(el: Element): boolean {
	return el.getAttribute('hydrate') === 'none';
}

/** True if this region fetches HTML later (`render="defer"`). */
export function is_deferred(el: Element): boolean {
	return el.getAttribute('render') === 'defer';
}

/** `{#if}` remount policy for `hydrate="none"` regions. Default `cache`. */
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

/**
 * Schedule string for the shared scheduler.
 * Deferred regions use `when`; waking regions use `hydrate`; default `load`.
 */
export function region_schedule(el: Element): string {
	if (is_deferred(el)) return el.getAttribute('when') || 'load';
	const h = el.getAttribute('hydrate');
	if (h && h !== 'none') return h;
	return 'load';
}

/**
 * Wake schedule from `hydrate`, or `null` when this region does not run JS
 * (`hydrate` absent / `'none'`). Used after a deferred HTML swap for phase 2.
 */
export function region_hydrate_schedule(el: Element): string | null {
	const h = el.getAttribute('hydrate');
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
