/**
 * THE HYDRATE CORE — everything an island needs only at the moment it hydrates: Svelte's
 * `hydrate`/`unmount`, the `NestedProvider` host, the devalue props parse, the page seed, the
 * DEV props guard. Loaded LAZILY by the region element on its first `#hydrate` (one dynamic
 * import, shared by every island), so a page whose islands all wake on `visible` or `interaction`
 * boots the runtime WITHOUT fetching Svelte's client runtime — that arrives with the first island
 * that actually wakes, together with the island's own chunk. The always-on core (`core.ts`) keeps
 * only what every region needs at connect: the schedule, the observers, the hole fetch.
 *
 * Stateless towards the element: the element owns its handle (`IslandHandle`) and its flags; this
 * module owns the how.
 */
import { hydrate, unmount, type Component } from 'svelte';
import { set_current_region, set_foreign_hydrate } from '../current-region.js';
import { capture_region_ids } from './region-ids.js';
import NestedProvider from '../NestedProvider.svelte';
import { kit_hydrates_page } from './kit-boot.js';
import { ABSOLUTE_URL_SCHEME } from './region-endpoint-url.js';
import { foreign_region_prop_revivers } from './foreign-props.js';
import { props_sidecar_of } from './sidecar.js';
import { SEED_REF_KEY, seed_ref_reviver } from '../seed-refs.js';
import { parse_sidecar_text, seed_data_of, seed_page_once, seed_remote_once } from './seeds.js';
import { is_deferred, ours_on_kit_document, region_ssr_truncated } from './region-attrs.js';
import { slots, type LiftedLake } from './slots.js';
import { parse_region_html } from './parse-html.js';
import { install as install_hydrate_features } from 'virtual:ogygia/hydrate-features';
// Re-exported for core's wake paths: observing Kit's reactive page needs Svelte, so it lives in this
// lazy chunk, never in the boot's static graph (see core.ts `hydrate_core`).
export { kit_page_thread } from './kit-page-thread.svelte.js';

// The HYDRATE-phase features (context, live, wire, remote-seeds — as the app's marks select them;
// link/runtime-entry.ts) install as this chunk evaluates: before any island below can hydrate, and
// without ever joining the boot. They ride this chunk's one `import()`, sized by the same marks.
install_hydrate_features();
import { emit as dt_emit } from '../devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** The morph contract for hydration repair: the exact server sequence — see `repair_markup`. */
const REPAIR_MORPH = { preserve_self_owned: false } as const;

/** A hydrated island as the element holds it: how to tear it down, and (keep / live hosts) how to
 *  push the next page's props into it. */
export type IslandHandle = {
	dispose(): void;
	set_props?: (props: Record<string, unknown>) => void;
};

/** An island's loaded module: the component, plus a foreign build's own hydrate contract.
 *  `options.recover === false` asks the entry's svelte to THROW on a hydration mismatch instead
 *  of silently re-rendering (the self-heal below needs to know); an older entry ignores it. */
export type IslandModule = {
	default: Component<Record<string, unknown>>;
	__og_hydrate?: (
		target: Element,
		props: Record<string, unknown>,
		options?: { recover?: boolean }
	) => unknown;
	__og_unmount?: (app: unknown) => void;
};

/** The hydration ENVELOPE: `hydrate()` anchors on a top-level `<!--[-->` comment and then expects
 *  the component's OWN region envelope — but embedded SSR (Region.svelte) emits only the inner
 *  layer. Idempotent: the second attempt after a failed first one finds it in place. */
function ensure_envelope(region: Element): void {
	if (has_envelope(region)) return;
	region.insertBefore(document.createComment('['), region.firstChild);
	region.appendChild(document.createComment(']'));
}
function has_envelope(region: Element): boolean {
	const first = region.firstChild;
	return !!first && first.nodeType === 8 && (first as Comment).data === '[';
}

/** Set the first time {@link neutralize_head_hydration_markers} runs on this document (once per page). */
let head_markers_neutralized = false;

/**
 * MAKE `<svelte:head>` HYDRATION SAFE on a csr=false document, before any island's head effect runs.
 * The caller runs this once per document (see the `head_markers_neutralized` guard at its call site).
 *
 * Svelte renders a component's `<svelte:head>` into `document.head`, not into the component's own
 * DOM, and delimits each block there as `<!--HASH-->` …content… `<!---->` (svelte/internal/server
 * `head()`). Its CLIENT `head(HASH, …)` hydrates by scanning document.head for the comment whose data
 * is HASH, then walking the nodes right after it as that block's content. That contract holds for a
 * whole-page hydrate (csr=true — Kit owns it, and this function never runs), but an ogygia island
 * hydrates in ISOLATION while that scan still reads the ONE shared document.head. By island-wake time
 * a third party has usually mutated the head (a design-system/monitoring inject, a hoisted sheet); a
 * foreign node landing in a block's range desyncs the walk into `set_attribute()` on a non-element,
 * which throws and discards the ENTIRE island (it never wakes). Note ogygia already keeps its OWN
 * head writes off this range by inserting region sheets at the head TOP (core.ts) — this closes the
 * same hole for head writes ogygia does not control.
 *
 * The fix is Svelte's own documented fallback: when `head()` finds no matching HASH marker it flips
 * out of hydration mode and RE-RENDERS the block fresh (svelte-head.js, `head_anchor === null`).
 * Removing the open markers up front takes every island's head down that safe path instead of the
 * fragile walk. The SSR-rendered head ELEMENTS stay (correct, already applied — sheets loaded, title
 * set); a waking island re-renders an idempotent copy of its own head content (a preload / meta /
 * resource hint — the browser dedupes it, and the first SPA head-merge replaces the head wholesale).
 *
 * A head block is `<!--HASH-->` …content… `<!---->` — the HASH open and the empty close both sit at
 * the head's TOP LEVEL, while the content in between may carry Svelte's own block anchors when the head
 * is looped or branched: `{#if}`/`{#each}`/`{:else}` emit `<!--[-->` / `<!--[!-->` / `<!--[?-->` opens
 * and `<!--]-->` closes (svelte constants HYDRATION_START… and HYDRATION_END). So the open markers are found
 * by walking head's DIRECT children while tracking bracket depth: a comment whose data starts with `[`
 * is a block open (depth+1), `]` is a block close (depth−1), and at depth 0 a non-bracket, non-empty
 * comment is a head-block HASH open — confirmed when a depth-0 empty `<!---->` later closes its block.
 * That confirmation is what tells a real head marker from a lone third-party head comment (which has no
 * depth-0 empty close), so only genuine markers are removed; page/layout head blocks keep every rendered
 * element (their inert markers go), and element children are never descended into.
 */
export function neutralize_head_hydration_markers(): void {
	const head = typeof document !== 'undefined' ? document.head : null;
	if (!head) return;
	let depth = 0;
	let pending_open: Comment | null = null;
	const to_remove: Comment[] = [];
	for (let n = head.firstChild; n; n = n.nextSibling) {
		if (n.nodeType !== 8) continue; // COMMENT_NODE
		const data = (n as Comment).data;
		if (data[0] === '[') {
			depth++; // block open: `[`, `[!`, `[?`
			continue;
		}
		if (data === ']') {
			if (depth > 0) depth--; // block close
			continue;
		}
		if (depth !== 0) continue; // an anchor inside a block — head-block CONTENT, never a marker
		if (data === '') {
			// A top-level empty comment closes the current head block, confirming its HASH open.
			if (pending_open) {
				to_remove.push(pending_open);
				pending_open = null;
			}
		} else {
			// A top-level non-bracket, non-empty comment is a head-block HASH open (svelte/internal/server
			// head() emits `<!--HASH-->`). Held until its block's empty close confirms it.
			pending_open = n as Comment;
		}
	}
	for (const m of to_remove) m.remove();
}

/**
 * Keep only the LAST `<title>` in document.head. When a csr=false island's `<svelte:head>` re-renders
 * (see {@link neutralize_head_hydration_markers}) it appends its own `<title>` after the page's SSR
 * one; the browser honours the FIRST `<title>`, so without this the island's — usually reactive —
 * title would never take effect. Dropping the earlier duplicate(s) lets it win, and Svelte then mutates
 * that surviving element's text in place on later updates. A no-op on the normal single-title page, so
 * it is safe to call after every island hydrate; guarded (like the neutralize) to a non-Kit document.
 */
export function dedupe_head_titles(): void {
	const head = typeof document !== 'undefined' ? document.head : null;
	if (!head) return;
	const titles = head.querySelectorAll('title');
	for (let i = 0; i < titles.length - 1; i++) titles[i].remove();
}

/**
 * REPAIR the island's light DOM toward its server markup, keeping every element it still has.
 *
 * Svelte's walk cares about the node SEQUENCE (elements, text, comments), never about attributes.
 * The edits sleeping islands actually receive keep the element skeleton and touch what is between
 * the elements: a design-system runtime strips the whitespace text nodes, an A/B tool leaves a
 * comment. So: match the live elements to the server markup's elements one to one (same count,
 * same tags, recursively), and rebuild only the text and comment nodes around them from the server
 * copy. No element is created, so no upgraded custom element reacts — the design-system element
 * that re-strips the island on every connect (measured on a customer deploy) is left exactly where
 * it is, and the walk that follows sees the server's sequence.
 *
 * Only when the element skeleton itself differs (an element removed or added) does the repair fall
 * to the morph (existing nodes still keep their identity where the morph can match them), or to a
 * plain `innerHTML` swap where the runtime has no morph. Those paths may re-create an element, and
 * a re-created element may react once more; the second attempt tells.
 *
 * The morph runs in its STRICT contract here ({@link REPAIR_MORPH}): the target is the server's node
 * sequence, exactly. The live morph's "a self-owned element keeps the children it gave itself" rule is
 * right for a hole re-answer, but in a repair it is the residue that breaks the walk — a node a
 * web-component runtime added inside a nested custom element is exactly what Svelte's cursor then
 * lands on (`getAttribute is not a function`), and the island discards.
 */
function repair_markup(region: HTMLElement, want: Element): void {
	if (align_to(region, want)) return;
	const nodes = Array.from(want.childNodes);
	const morph = slots.morph;
	if (morph) morph(region, nodes, REPAIR_MORPH);
	else region.replaceChildren(...nodes);
}

/**
 * Does the live node SEQUENCE differ from the server's? Exactly what Svelte's walk reads: node
 * types, element tags, text and comment data, recursively — never attributes (a custom element
 * upgrading adds `tabindex`, `aria-*`, ids; the walk does not care, and neither does this).
 *
 * Asked BEFORE the first hydrate attempt, not after a failed one: Svelte's walk does not verify
 * tags, so on a shifted sequence it writes attributes onto whatever node sits at its cursor —
 * measured on a customer deploy, the login trigger's `id`/`class`/`text` landed on the dropdown's
 * wrapper `<div>` — and only throws further down. A repair that came after would put the text
 * nodes back and leave those attributes on the wrong elements (an unstyled dropdown). Repairing
 * first, the walk never runs on the edited sequence.
 */
export function sequence_differs(live: Node, want: Node): boolean {
	const a = live.childNodes;
	const b = want.childNodes;
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.nodeType !== y.nodeType) return true;
		if (x.nodeType === 1) {
			if ((x as Element).tagName !== (y as Element).tagName) return true;
			if (sequence_differs(x, y)) return true;
		} else if (x.nodeValue !== y.nodeValue) return true;
	}
	return false;
}

/** Any non-whitespace char? A char-code scan, not `/\S/` — this walks on every drift check. */
function has_non_ws(s: string | null): boolean {
	if (!s) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c !== 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) return true;
	}
	return false;
}

/** A short label for a node in a divergence message: the tag for an element, else its kind. */
function node_label(n: Node): string {
	if (n.nodeType === 1) return `<${(n as Element).tagName.toLowerCase()}>`;
	if (n.nodeType === 3) return has_non_ws(n.nodeValue) ? 'a text node' : 'whitespace';
	if (n.nodeType === 8) return 'a comment';
	return 'a node';
}

/** A guess at WHAT left a foreign node in the region's light DOM, read off the node's shape — the
 *  tell-tales of the passes that reshape a region between SSR and wake: a scoped-CSS or web-component
 *  runtime, a declarative-shadow-DOM injector, a whitespace normalizer. Names the observable evidence
 *  (a tag, an attribute pattern), never a specific tool. The "why" a recovery is otherwise silent
 *  about; empty when nothing recognizable. */
function culprit_hint(n: Node): string {
	if (n.nodeType !== 1) return '';
	const el = n as Element;
	const tag = el.tagName.toLowerCase();
	if (tag === 'style') return ' — an injected <style> (scoped CSS from a component/design-system runtime)';
	if (tag === 'template' && el.hasAttribute('shadowrootmode'))
		return ' — a declarative shadow-DOM template injected after SSR';
	for (const a of el.attributes)
		if (a.name.startsWith('sc-') || a.name === 's-id' || a.name === 'c-id' || a.name === 's-sn')
			return ' — scoped web-component hydration marks (sc-*, s-id, c-id) a component runtime stamped over the island';
	if (el.classList.contains('hydrated'))
		return ' — a web-component runtime marked it `hydrated`';
	return '';
}

/** Describe the FIRST place the live light DOM diverges from `want` (the server copy) — the specific
 *  reason an island drifted, for the DEV console + devtools (never a bare "it was recovered"). Mirrors
 *  {@link sequence_differs}' walk exactly, so it names the divergence that trips the repair. `null`
 *  when the sequences match. DEV / devtools only — prod DCEs the call site, so this never runs there. */
function describe_divergence(live: Node, want: Node, where = 'the island'): string | null {
	const a = live.childNodes;
	const b = want.childNodes;
	if (a.length !== b.length) {
		// Find the FIRST position the two sequences diverge (an insertion/removal can be anywhere, not
		// just the tail): the node there in the longer list is what was added / dropped.
		const longer = a.length > b.length ? a : b;
		const shorter = a.length > b.length ? b : a;
		let i = 0;
		while (
			i < shorter.length &&
			longer[i].nodeType === shorter[i].nodeType &&
			(longer[i].nodeType !== 1 ||
				(longer[i] as Element).tagName === (shorter[i] as Element).tagName)
		)
			i++;
		const node = longer[i] ?? longer[longer.length - 1];
		if (a.length > b.length)
			return `${a.length - b.length} node(s) were inserted into ${where} — e.g. ${node_label(node)}${culprit_hint(node)}`;
		const ws = node.nodeType === 3 && !has_non_ws(node.nodeValue);
		return `${b.length - a.length} node(s) the server sent were removed from ${where} — e.g. ${node_label(node)}${ws ? ' (whitespace stripped by a DOM-normalizing pass)' : ''}`;
	}
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.nodeType !== y.nodeType || (x.nodeType === 1 && (x as Element).tagName !== (y as Element).tagName))
			return `${where}: the server sent ${node_label(y)} but the browser had ${node_label(x)}${culprit_hint(x)}`;
		if (x.nodeType === 1) {
			const deeper = describe_divergence(x, y, node_label(x));
			if (deeper) return deeper;
		} else if (x.nodeValue !== y.nodeValue) {
			return `${where}: the text of ${node_label(y)} changed (a translator or text rewrite)`;
		}
	}
	return null;
}

/** Put the island's light DOM back to the server's node sequence when it drifted while the island
 *  slept. Returns whether a repair was made and, in DEV / devtools, WHY it drifted (the first
 *  divergence, named before the repair rewrites the sequence). Called with the island's lakes LIFTED
 *  (lakes.ts): a lake's content is never part of the walk, and it may legitimately differ from the
 *  server copy by now (a live lake refreshes itself to the visitor before its host wakes) — so the
 *  copy's direct lakes are emptied the same way before the comparison, and the repair never touches
 *  them. */
export function repair_if_drifted(
	region: HTMLElement,
	ssr_html: string
): { repaired: boolean; reason: string | null } {
	// Parse through the ONE DSD-aware parser (parse-html.ts): the content stays inert (a template's
	// content never upgrades — attaching a declarative shadow root is a parse step, not an upgrade), but
	// a `<template shadowrootmode>` in the copy is consumed into a shadow root instead of lingering as an
	// inert light-DOM child. That keeps `want`'s light-DOM sequence consistent with a live region whose
	// hosts already carry shadow roots, so a server copy that happens to carry DSD can't trip
	// sequence_differs. Today ssr_html is the region's own live innerHTML (never serialises a shadow), so
	// this is belt-and-braces — but it means there is no second, DSD-unaware parse to drift.
	const content = parse_region_html(ssr_html);
	// The copy under a region of its own — in the parse fragment's inert document, so the element never
	// upgrades — lifted by the very routine that lifted the live island (what it leaves in a lake, it
	// leaves in both).
	const want = content.ownerDocument.createElement('ogygia-region');
	want.appendChild(content);
	slots.lakes.lift(want);
	if (!sequence_differs(region, want)) return { repaired: false, reason: null };
	// Name the drift BEFORE repairing (repair rewrites the live sequence). The string is read only by
	// the DEV console + devtools, so a prod-without-devtools build skips building it (the walk DCEs).
	const reason = import.meta.env.DEV || DEVTOOLS ? describe_divergence(region, want) : null;
	repair_markup(region, want);
	return { repaired: true, reason };
}

/** Make `live`'s child sequence the server's (`want`), keeping `live`'s elements. `false` when the
 *  element skeleton differs (no changes made at that level). */
function align_to(live: Element, want: Element | DocumentFragment): boolean {
	const live_elements = element_children(live);
	const want_elements = element_children(want);
	if (live_elements.length !== want_elements.length) return false;
	for (let i = 0; i < live_elements.length; i++) {
		if (live_elements[i].tagName !== want_elements[i].tagName) return false;
	}
	// Children first: a subtree the server sent differently in its elements is the morph's, and the
	// morph must see that subtree untouched by this level's rebuild.
	for (let i = 0; i < live_elements.length; i++) {
		if (!align_to(live_elements[i], want_elements[i])) {
			const morph = slots.morph;
			if (morph) morph(live_elements[i], Array.from(want_elements[i].childNodes), REPAIR_MORPH);
			else live_elements[i].innerHTML = (want_elements[i] as Element).innerHTML;
		}
	}
	// This level: drop every live text / comment node, then put the server's back around the
	// (untouched) elements, in the server's order.
	for (const node of Array.from(live.childNodes)) if (node.nodeType !== 1) node.remove();
	let next = 0;
	for (const node of Array.from(want.childNodes)) {
		if (node.nodeType === 1) {
			next++;
			continue;
		}
		const before = live_elements[next] ?? null;
		live.insertBefore(node.cloneNode(true), before);
	}
	return true;
}

function element_children(node: Node): Element[] {
	const out: Element[] = [];
	for (const child of node.childNodes) if (child.nodeType === 1) out.push(child as Element);
	return out;
}

/** Svelte's own line from inside its hydrate catch, printed BEFORE it throws `hydration_failed`
 *  to us. A speculative attempt (recovery off) is ours to report — healed, or handed to Svelte's
 *  recovery, which prints its own line then. Swallow exactly this message for the synchronous
 *  duration of such an attempt, nothing else. */
const SVELTE_FAILED_TO_HYDRATE = 'Failed to hydrate';
function quietly<T>(fn: () => T): T {
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		if (typeof args[0] === 'string' && args[0].startsWith(SVELTE_FAILED_TO_HYDRATE)) return;
		warn.apply(console, args);
	};
	try {
		return fn();
	} finally {
		console.warn = warn;
	}
}

const HEALED_WARNING =
	'[ogygia] island "%s" was edited while it slept (its light DOM no longer matched the server ' +
	'render — a design-system runtime, an A/B tool, a translator), so its server HTML was put back ' +
	'and hydrated instead of re-rendering it client-side. Whatever the edit added is gone; the ' +
	'script that made it should leave <ogygia-region> subtrees alone.';

/** Is this entry another build's (fragment federation): absolute, different origin. */
export function is_foreign_entry(entry: string): boolean {
	return ABSOLUTE_URL_SCHEME.test(entry) && new URL(entry).origin !== location.origin;
}

// The devalue revivers only depend on `slots.wire`, which is set once at boot and never changes.
// Building this object (plus its two closures) fresh for every island was pure per-hydrate GC churn;
// memoize it against the wire identity so N islands share ONE revivers object.
let cached_wire: (typeof slots)['wire'] | undefined;
let cached_revivers: Record<string, (d: never) => unknown> | undefined;
function region_prop_revivers(): Record<string, (d: never) => unknown> | undefined {
	const wire = slots.wire;
	if (wire === cached_wire) return cached_revivers;
	cached_wire = wire;
	cached_revivers = wire
		? { [wire.REF_WIRE_KEY]: (d: never) => wire.resolve(d, true) }
		: {
				// Insurance against a feature-detection miss: the server encoded a wired value but this
				// build's runtime omitted the wire feature. Say so instead of devalue's bare "Unknown
				// type OgygiaRef" — the opaque form cost a real debugging session (the factory-registry
				// placement the detector used to miss). Short on purpose: this string ships in core.
				OgygiaRef: () => {
					throw new Error(
						'wired prop but no wire feature in this build — ogygia detection bug, please report'
					);
				}
			};
	return cached_revivers;
}

/**
 * Parse a region's `<script data-ogygia-props>` sidecar (keyed at the end of the body, or adjacent —
 * runtime/sidecar.ts). Uses the client reviver (`remember: true`) so a named/shared transportable
 * reunites with its live instance. Returns `{}` when there is no props sidecar.
 */
export function read_region_props(region: Element, foreign = false): Record<string, unknown> {
	const sidecar = props_sidecar_of(region);
	if (!sidecar) return {};
	const base = foreign ? foreign_region_prop_revivers() : region_prop_revivers();
	// A foreign fragment never carries seed references (its props are self-contained by
	// construction); a local island's may point into the seed of the document the sidecar came
	// from — the live page store, or a navigation's incoming document (runtime/seeds.ts). The seed
	// element is resolved once per read, lazily, by the reviver.
	const doc = sidecar.ownerDocument;
	const revivers = foreign
		? base
		: { ...base, [SEED_REF_KEY]: seed_ref_reviver(() => seed_data_of(doc)) };
	return parse_sidecar_text(sidecar, revivers) as Record<string, unknown>;
}

/**
 * DEV-ONLY props mutation guard. Island props cross the boundary as a serialized devalue snapshot
 * of the host — or, for a seed REFERENCE, as the page seed's own node, shared by reference with
 * `page.data` and every other island that references it. Writing to either inside the island is a
 * bug: the snapshot updates nothing, the reference leaks into page.data.
 */
class PropMutationGuard {
	#warned = new Set<string>();

	#warn(entry: string, prop_path: string) {
		const key = entry + '' + prop_path;
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		console.warn(
			`[ogygia] mutating prop '${prop_path}' inside island ${entry} — island props are a serialized ` +
				`snapshot of the host, or a reference into page.data shared with every island that reads it: ` +
				`the write updates nothing (or leaks into page.data). Move mutable state inside the island component.`
		);
	}

	#guard_map(map: Map<unknown, unknown>, entry: string, prop_path: string) {
		const mutators = new Set(['set', 'delete', 'clear']);
		return new Proxy(map, {
			get: (target, prop) => {
				const value = Reflect.get(target, prop);
				if (typeof value !== 'function') return value;
				if (typeof prop === 'string' && mutators.has(prop)) {
					return (...args: unknown[]) => {
						this.#warn(entry, `${prop_path}.${prop}()`);
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
		});
	}

	#guard_set(set: Set<unknown>, entry: string, prop_path: string) {
		const mutators = new Set(['add', 'delete', 'clear']);
		return new Proxy(set, {
			get: (target, prop) => {
				const value = Reflect.get(target, prop);
				if (typeof value !== 'function') return value;
				if (typeof prop === 'string' && mutators.has(prop)) {
					return (...args: unknown[]) => {
						this.#warn(entry, `${prop_path}.${prop}()`);
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
		});
	}

	#guard_value(value: unknown, entry: string, prop_path: string): unknown {
		if (value === null || typeof value !== 'object') return value;
		if (value instanceof Map)
			return this.#guard_map(value as Map<unknown, unknown>, entry, prop_path);
		if (value instanceof Set) return this.#guard_set(value as Set<unknown>, entry, prop_path);
		if (value instanceof Date || value instanceof RegExp || value instanceof URL) return value;
		// A class INSTANCE must never be wrapped. A wired live object (e.g. a `Cart` whose `$state`
		// fields Svelte compiles to private `#fields`) breaks under a Proxy: private-field access and
		// `this`-dependent getters/methods run against the proxy, not the real instance, and throw
		// ("cannot read private member … from an object whose class did not declare it"). The guard
		// only needs to catch mutation of captured SNAPSHOT props, which are always plain data —
		// devalue serializes exactly plain objects, arrays, Map/Set/Date. So guard those; pass class
		// instances (the intentionally-live wired objects) straight through.
		const proto = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
		return new Proxy(value as Record<string | symbol, unknown>, {
			get: (target, prop, receiver) => {
				const child = Reflect.get(target, prop, receiver);
				if (typeof prop === 'symbol') return child;
				return this.#guard_value(
					child,
					entry,
					prop_path ? `${prop_path}.${String(prop)}` : String(prop)
				);
			},
			set: (target, prop, next, receiver) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.set(target, prop, next, receiver);
			},
			deleteProperty: (target, prop) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.deleteProperty(target, prop);
			},
			defineProperty: (target, prop, descriptor) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.defineProperty(target, prop, descriptor);
			}
		});
	}

	wrap(props: Record<string, unknown>, entry: string): Record<string, unknown> {
		if (!(import.meta.env && import.meta.env.DEV)) return props;
		return this.#guard_value(props, entry, '') as Record<string, unknown>;
	}
}

const prop_guard = new PropMutationGuard();

/** Svelte's `unmount`, typed for the opaque app this module hands around. */
const unmount_app = (app: unknown) => void unmount(app as Record<string, unknown>);

/** A handle over a mounted Svelte app: dispose unmounts, `set_props` pushes through a host. */
function handle(
	app: unknown,
	dispose_with: (app: unknown) => void,
	entry: string,
	host: boolean
): IslandHandle {
	const h: IslandHandle = {
		dispose() {
			try {
				dispose_with(app);
			} catch {
				/* noop */
			}
		}
	};
	if (host) {
		const live = app as { setProps?: (p: Record<string, unknown>) => void };
		h.set_props = (props) => live.setProps?.(prop_guard.wrap(props, entry));
	}
	return h;
}

/**
 * THE island hydrate step — synchronous from here on (the element already awaited the module and
 * its scheduler turn): seeds, props, envelope, `hydrate()` through the provider, lake restore,
 * the mutation detector. Returns the handle, or `null` when the island is not ours to hydrate (a
 * Kit-hydrated page — marked `data-kit-hydrated`). Throws on a failed hydrate; the element reports.
 */
export function hydrate_island(
	region: HTMLElement,
	entry: string,
	mod: IslandModule,
	/** The island's server markup as it connected (core.ts) — the HYDRATION SOURCE OF TRUTH. When
	 *  the live DOM drifted from it while the island slept, hydration is retried against it before
	 *  any client render. `null` = no copy (a huge island, an older path): Svelte's own recovery. */
	ssr_html: string | null = null
): IslandHandle | null {
	// Seed SSR-resolved remote queries + document page snapshot once before hydrate.
	seed_remote_once();
	seed_page_once();
	const Component = mod.default;

	// FOREIGN origin (fragment federation)? Decided from the ENTRY alone — a foreign island's props
	// must parse plain (membrane) whether or not its module carries the hydrate contract.
	const foreign = is_foreign_entry(entry);

	// R3 ownership: capture which page hub ids this island resolves from its props, so a reconcile
	// nav can dispose exactly this region's ids if it is later removed.
	const props = capture_region_ids(region, () => read_region_props(region, foreign));

	// Mixed mode: on a csr=true page Kit already hydrates this component — skip. EXCEPT what Kit
	// never sees (`ours_on_kit_document`): a deferred region (its HTML was FETCHED after load and
	// swapped in, never part of Kit's SSR tree — connectedCallback carries the same exception for
	// the fetch phase), a region INSIDE A LAKE (the lake wrapper adopts its SSR element under Kit
	// as opaque DOM), and a region INSIDE A HOLE'S FETCHED ANSWER (an island a server island
	// carries — a personal, interactive menu — that Kit could never hydrate). Those are ours.
	if (kit_hydrates_page() && !ours_on_kit_document(region)) {
		region.setAttribute('data-kit-hydrated', '');
		if (import.meta.env.DEV) {
			console.warn(
				`[ogygia] island "${entry}" is on a csr=true page; Kit hydrates it, so the island directive is redundant here (it behaves as a normal component).`
			);
		}
		return null;
	}

	// csr=false document: this island (and every one after it) hydrates in isolation against the ONE
	// shared document.head, so make its `<svelte:head>` hydration safe before any head effect runs.
	// Guarded to a non-Kit document — a csr=true page's head is Kit's to hydrate, untouched. See
	// neutralize_head_hydration_markers. (`ours_on_kit_document` islands on a csr=true page reach here
	// too, but Kit has long finished its head pass by the time a fetched hole/lake wakes; still, we
	// only run this where Kit does NOT own the page.)
	if (!kit_hydrates_page() && !head_markers_neutralized) {
		head_markers_neutralized = true;
		neutralize_head_hydration_markers();
	}

	// INVALID-NESTING GUARD: the browser parser hoists a BLOCK island rendered inline inside a
	// `<p>` out of its region before any JS runs (see region_ssr_truncated). The region is now
	// empty, so the hydrate below fresh-mounts a SECOND copy while the server copy lingers as an
	// orphan sibling of the paragraph. This is invalid HTML the framework cannot un-parse — warn
	// loudly (dev) instead of silently duplicating; the real fix lives in authoring (render an
	// inline element, or place the island in block context).
	if (import.meta.env.DEV && !is_deferred(region) && region_ssr_truncated(region)) {
		console.warn(
			`[ogygia] island "${entry}" rendered a BLOCK element inline inside a <p> (or other ` +
				`phrasing-only context). The browser's HTML parser hoisted that block out of the ` +
				`paragraph before hydration, so this region is empty and a SECOND copy is about to mount ` +
				`here — the server-rendered copy is now an orphaned sibling of the paragraph. Fix: make ` +
				`the component render an inline element (e.g. <span> instead of <div>), or place the ` +
				`island on its own line (block context) rather than inside a sentence.`
		);
	}

	// BOX-STABILITY THROUGH WAKE needs NOTHING here, and ogygia must not touch the region's box. This
	// whole step — lake lift, repair, Svelte's claim (or its recovery re-render), lake restore — is ONE
	// synchronous task: the browser cannot paint between the detach and the re-attach, so no frame ever
	// shows the region empty (test/browser/region-hydrate-no-shift.test.ts samples every frame). A
	// former "hold" set the region to `display:block` + a `min-height` for one painted frame to guard
	// against that non-existent frame; the style flip itself re-laid-out the region under the page's
	// CSS (an inline region is block-in-inline; block changes its children's containing block and
	// anonymous boxes) and cost a customer hero a 0.69 layout shift, plus a forced layout per island.

	// THE HYDRATION SOURCE OF TRUTH is the island's server markup, not whatever the live DOM is
	// now. An island can sleep for a long time (`visible`, `interaction`), and other scripts edit
	// the page meanwhile — a design-system runtime stripping whitespace text nodes while it
	// "hydrates" the header around it, an A/B tool, a translator. Svelte's walk then meets a
	// different node sequence and, left to itself, throws the server DOM away and re-renders the
	// island client-side: a flash, DSD/foreign content destroyed, and the tap that woke the
	// island replayed onto a discarded node (a login dropdown needed two clicks). So, BEFORE the
	// walk runs (see sequence_differs for why before), the live sequence is compared with the
	// server's and put back when it drifted; the walk then sees the server's sequence. Measured
	// on what the walk sees: the lakes lifted (repair_if_drifted empties the copy's the same way).
	let lifted: LiftedLake[] | null = slots.lakes.lift(region);
	const drift =
		ssr_html !== null && region.isConnected
			? repair_if_drifted(region, ssr_html)
			: { repaired: false, reason: null };
	const repaired = drift.repaired;
	try {
		if (!region.isConnected) return null;
		// FOREIGN-MUTATION DETECTOR (arm): a successful hydration CLAIMS the server-rendered nodes —
		// they stay in the region. Svelte 5's mismatch recovery instead silently discards them and
		// re-renders fresh, which reads as success here while the SSR content (and anything a
		// post-SSR transform injected into it — declarative shadow DOM, A/B edits) is destroyed.
		// Remember the SSR element children (post-lake-lift) so the check below can tell a claim
		// from a recovery. See internal/notes/foreign-dom.md.
		const ssr_children = Array.from(region.children);

		// FOREIGN delegation (fragment federation): the entry came from another build/origin and
		// exports its own `__og_hydrate` — envelope preparation belongs to the svelte that compiled
		// the entry, so the consumer must not shape it.
		const foreign_delegate = foreign && typeof mod.__og_hydrate === 'function';

		// Foreign islands take RAW props: the dev mutation-guard proxy is THIS build's code running
		// inside another build's render — harmless, but it's a wire, and we don't cross wires.
		// (Plain data either way; the parse membrane already enforced that.)
		const wrapped = foreign ? props : prop_guard.wrap(props, entry);
		// Keep needs SPA navigation — a full-page load throws the DOM away, so there is nothing
		// to relocate. Warn (dev) when the router is off on this page.
		const LiveHost = slots.live;
		const keep = region.hasAttribute('data-ogygia-keep') && !!LiveHost;
		if (keep && import.meta.env.DEV && !document.querySelector('meta[name="ogygia-router"]')) {
			console.warn(
				`[ogygia] island "${entry}" has keep:'${region.getAttribute('data-ogygia-keep')}' but the SPA router is off (ogygia({ router: false })) — keep relies on SPA navigation; a full-page load replaces the DOM, so the attribute is a no-op here.`
			);
		}

		/**
		 * ONE hydrate attempt. `recover: false` makes Svelte THROW on a mismatch (`hydration_failed`)
		 * instead of silently discarding the server DOM and re-rendering — that silent path is what
		 * the self-heal below replaces; `recover: true` is that path, the last resort.
		 *
		 * Hydration envelope: `render()` (region endpoint / deferred swap) has BOTH anchor layers —
		 * do not wrap again or hydration mismatches. (Verified against svelte 5.56.) Hydrate through
		 * NestedProvider so descendants see the "inside a hydrated island" context — any nested
		 * island wrapper then degrades to a plain inline component (single hydration with this
		 * parent). The provider adds no DOM, so this matches SSR.
		 */
		const attempt = (recover: boolean): IslandHandle => {
			if (!is_deferred(region) && !foreign_delegate) ensure_envelope(region);
			set_current_region(region);
			try {
				if (foreign_delegate) {
					// FOREIGN island: its module-level svelte state is not ours, so delegate the whole
					// hydrate to the entry's own `__og_hydrate` (and remember its unmounter). No
					// NestedProvider, no context capture — context deliberately does not cross a team
					// boundary. FOREIGN PAGE READS: the `$app/state` shim inside this island reads the
					// SHELL's page store (one singleton per document — the MFE's own seed never crosses
					// the fragment boundary). Mark the hydrate so that shim can warn (dev) when the island
					// reads page.data/params/route/form/error: its SSR HTML was rendered with the MFE's
					// own load.
					set_foreign_hydrate({ origin: new URL(entry).origin, entry });
					const app = mod.__og_hydrate!(region, wrapped, recover ? undefined : { recover: false });
					return handle(app, mod.__og_unmount ?? (() => {}), entry, false);
				}
				// Seed this island's context from any `<Provide>` above it in the DOM, so a child's plain
				// `getContext('key')` reads a (csr=false) layout's context across the island-root split.
				// Undefined when there is no provider above — the common case pays only a short DOM walk.
				const provided_ctx = capture_region_ids(region, () => slots.context?.(region));
				const recovery = recover ? {} : { recover: false as const };
				// A PERSIST island hydrates through LiveHost (same no-DOM render as NestedProvider) so
				// that when it relocates onto the next page its props can be pushed in reactively.
				if (keep) {
					const app = hydrate(LiveHost!, {
						target: region,
						props: { component: Component, initialProps: wrapped },
						...(provided_ctx ? { context: provided_ctx } : {}),
						...recovery
					});
					return handle(app, unmount_app, entry, true);
				}
				const app = hydrate(NestedProvider, {
					target: region,
					props: { component: Component, props: wrapped },
					...(provided_ctx ? { context: provided_ctx } : {}),
					...recovery
				});
				return handle(app, unmount_app, entry, false);
			} finally {
				set_current_region(null);
				set_foreign_hydrate(null);
			}
		};

		// The sequence is the server's now (repaired above when it had drifted, see there). So:
		//   1. hydrate with recovery OFF — it matches by construction, a repaired island is healed;
		//   2. only if that fails (the component itself threw, or the server copy was not enough),
		//      let Svelte recover the way it always did, and the detector below reports the discard.
		let out: IslandHandle;
		let healed = false;
		// What Svelte threw on the STRICT attempt. `quietly` hides Svelte's own "Failed to hydrate" log for
		// that attempt by design, so without this the recovery warning below could never say WHY the
		// walk failed — only that the pre-hydrate check saw drift, which repair may well have fixed.
		let strict_error: unknown = null;
		try {
			out = quietly(() => attempt(false));
			healed = repaired;
		} catch (err) {
			strict_error = err;
			out = attempt(true);
		}
		if (healed) {
			// The reason is the "why" — recorded on the element so DOM inspection shows it, carried on
			// the devtools event, and appended to the console line. Empty string when unknown.
			region.setAttribute('data-og-healed', drift.reason || '');
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.healed',
					entry,
					fp: region.getAttribute('data-og-fp') || undefined,
					reason: drift.reason || undefined
				});
			if (import.meta.env.DEV)
				console.warn(HEALED_WARNING + (drift.reason ? `\nWhat drifted: ${drift.reason}` : ''), entry);
		}

		// Restore each frozen region's SSR DOM AFTER hydrate. An inner waking region whose
		// `<ogygia-region wake="…">` (re)connects then self-runs — the freeze made its subtree dead
		// again, so the nearest-boundary rule wakes that inner region.
		slots.lakes.restore(region, lifted);
		lifted = null; // ownership transferred

		// Region was torn out during hydrate (SWR replaceChildren on an ancestor lake) — drop the
		// orphan app.
		if (!region.isConnected) {
			out.dispose();
			return null;
		}

		// FOREIGN-MUTATION DETECTOR (check): if EVERY SSR element child was discarded during hydrate,
		// Svelte's silent mismatch recovery threw the server DOM away and re-rendered this island
		// client-side. The usual cause is something mutating the region's HTML between SSR and wake —
		// a post-SSR transform (`transformPageChunk`, a DSD-injecting middleware), an A/B tool, an
		// edge rewriter. A legitimate claim keeps the nodes (a browser-only `{#if}` may drop SOME, so
		// only zero survivors trips this).
		if (ssr_children.length > 0 && !ssr_children.some((el) => region.contains(el))) {
			// `drift.reason` is the specific first divergence captured at the pre-hydrate check (the DOM
			// there was still the mutated one). Null when the sequences matched yet Svelte recovered
			// anyway — a mismatch our walk does not see (an attribute, a Svelte-internal anchor) — then
			// the general guidance below stands on its own.
			region.setAttribute('data-og-recovered', drift.reason || '');
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.recovered',
					entry,
					fp: region.getAttribute('data-og-fp') || undefined,
					reason: drift.reason || undefined
				});
			console.warn(
				`[ogygia] island "${entry}" discarded its ENTIRE server-rendered DOM during hydration ` +
					`and re-rendered client-side (Svelte hydration-mismatch recovery). Three things cause this. ` +
					`(1) Something changed this region's HTML between SSR and wake — a post-SSR transform ` +
					`(transformPageChunk / an HTML-rewriting middleware), an A/B-testing snippet, or an edge ` +
					`rewriter; whatever it injected (e.g. declarative shadow DOM) was just destroyed, and the ` +
					`swap is timing-dependent, so symptoms look erratic. (2) A component in this island reads a ` +
					`page/layout CONTEXT via plain Svelte setContext — on csr=false that runs only on the server, ` +
					`so getContext returns undefined on the client and the island renders a different tree. ` +
					`(3) A block in this island ({#if} / {:else if} / {#each} / {#await}) took a DIFFERENT branch ` +
					`on the client than on the server — its condition reads something that differs between the ` +
					`two (a browser global, a store's client default, url/page state, a Date). Svelte recovers a ` +
					`branch mismatch SILENTLY (no throw); the walk is then off and the rest of the tree follows.` +
					(drift.reason ? `\nWhat changed: ${drift.reason}` : '') +
					// The walk's own verdict, after any repair — the one line that separates "repair left a
					// residue" (1) from "the sequence was fine and Svelte failed for a reason this walk can't see"
					// (2/3). No drift AND no throw is the signature of (3): nothing touched this region's DOM.
					(strict_error
						? `\nSvelte threw on the strict attempt (after repair): ${strict_error instanceof Error ? strict_error.message : String(strict_error)}`
						: drift.reason
							? `\nSvelte did not throw after the repair — the mismatch is one this walk does not model.`
							: `\nThe server node sequence was INTACT and Svelte did not throw: nothing mutated this ` +
								`region's DOM, so this is (3) (or (2)). Find the block whose branch differs: in the ` +
								`server markup its anchor reads <!--[N--> where N is the branch the SERVER chose.`) +
					`\nFix: for (1) make the mutation invisible to hydration (mutate only <head>, attributes, or ` +
					`shadow templates — never the region's light DOM), or freeze the foreign-owned subtree with a ` +
					`wake:'none' (lake) boundary; for (2) provide the value with setContext / <Provide> / ` +
					`createContext imported from 'ogygia', read it with the same getContext(key); for (3) make ` +
					`the condition read the same value on both sides (a prop / page.data), or move the ` +
					`browser-only branch behind an $effect / hydratedBy().`
			);
		}

		// If this island's `<svelte:head>` re-rendered its own <title> (the re-render path opened by
		// neutralize_head_hydration_markers), it landed AFTER the SSR title, and the browser honours the
		// FIRST — so drop the earlier duplicate(s) and let the island's title win and update live. A
		// no-op on the normal one-title page. Only where that re-render path ran — a non-Kit document; a
		// csr=true page's head is Kit's, and any second title there is the app's, not ours to remove.
		if (!kit_hydrates_page()) dedupe_head_titles();
		return out;
	} finally {
		// If hydrate threw after lift, put lake DOM back so the page isn't permanently blank.
		if (lifted) slots.lakes.restore(region, lifted);
	}
}

/**
 * Hydrate a live region's swapped-in HTML through {@link LiveHost} (props-pushable). A live region's
 * HTML comes from svelte `render()` (both envelope layers) — same as the deferred swap path, so it
 * is NOT wrapped in extra `[..]` hydration comments. `null` when the live feature is absent.
 */
export function hydrate_live(
	region: HTMLElement,
	entry: string,
	mod: IslandModule,
	props: Record<string, unknown>
): IslandHandle | null {
	seed_remote_once();
	seed_page_once();
	const LiveHost = slots.live;
	if (!LiveHost) {
		if (import.meta.env.DEV) {
			console.warn('[ogygia] live region needs the live feature plugin (LiveHost missing)');
		}
		return null;
	}
	const provided_ctx = capture_region_ids(region, () => slots.context?.(region));
	const app = hydrate(LiveHost, {
		target: region,
		props: { component: mod.default, initialProps: prop_guard.wrap(props, entry) },
		...(provided_ctx ? { context: provided_ctx } : {})
	});
	return handle(app, unmount_app, entry, true);
}
