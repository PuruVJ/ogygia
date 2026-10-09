/**
 * # DOM ownership — who owns a node inside a region (internal/notes/dom-ownership.md)
 *
 * Every ogygia DOM writer (the pre-hydration drift check and repair, the morph behind hole answers /
 * live ticks / navigations, drift-watch) asks THIS module whether it may touch an element, instead of
 * re-deriving the answer from its own subset of signals. One answer per element, one precedence:
 *
 * | owner     | what                                                                  |
 * |-----------|-----------------------------------------------------------------------|
 * | `foreign` | a subtree the app declared the live DOM's own (`data-ogygia-keep` / `data-persist` on a plain element) |
 * | `region`  | a hydrated region root: Svelte's reactivity owns it now, not a morph  |
 * | `page`    | `<ogygia-slot>`: host-page content an island adopts whole             |
 * | `static`  | an element the compiler stamped `data-og-opaque` — render output Svelte's hydration never walks into (`{@html}`, `bind:innerHTML`, a custom element with static children) — or a child element of one stamped `data-og-html` (it may be `{@html}` content) |
 * | `walk`    | everything else: render output Svelte's walk binds by position        |
 *
 * (Lakes are the sixth owner; the hydrate core lifts them out of both trees before any comparison,
 * so no writer here meets one.) What each writer does with each owner is the contract table in the
 * note; the short form:
 *  - the DRIFT CHECK and the REPAIR keep only `walk` in the server's shape — every other owner is one
 *    sibling to Svelte's walk (tag + position), never entered;
 *  - the MORPH never enters `foreign` or `region` (nor a morph ROOT that is `foreign`), and patches
 *    `static` / `page` / `walk` toward the answer;
 *  - DRIFT-WATCH ignores a change made inside a non-`walk` subtree (a widget upgrading its own light
 *    DOM is not the island drifting).
 *
 * `data-ogygia-keep` on an `<ogygia-region>` is NOT `foreign`: there it names an island that survives
 * navigation (KeepHost) — Svelte owns that island, and it is repaired and hydrated like any other.
 *
 * FACETS (note §11): `owner_of` answers who writes INSIDE an element; the same module answers who
 * writes its ATTRIBUTES (`attributes_writer`, `REGION_RENDER_ATTRS`), who ORDERS its children
 * (`order_owner`), and whether a child EXISTS by the render's doing (`render_made`): one element, four
 * facets, one place. The morph's matching, attribute sync and removal all read them.
 */

/** The owner of an element, for the writers that consult it. */
export type Owner = 'foreign' | 'region' | 'page' | 'static' | 'walk';

/** The compiler's server-only stamp: Svelte's hydration never walks inside this element. */
export const OPAQUE_ATTR = 'data-og-opaque';
/** The compiler's server-only stamp on an element holding an `{@html}` BESIDE other children: its
 *  child elements may be `{@html}` content, which Svelte never walks into. (PROD output opens an
 *  `{@html}` block with the same `<!---->` as any separator, so the exact range is not knowable from
 *  the DOM; its child elements are compared by tag and position only, never entered.) */
export const HTML_PARENT_ATTR = 'data-og-html';

const REGION = 'ogygia-region';
const SLOT = 'ogygia-slot';

/** The app declared this subtree the live DOM's own: a plain element carrying `data-ogygia-keep` or
 *  `data-persist` (on a region, keep names a navigation-surviving island instead — not foreign). */
export function is_declared_foreign(el: Element): boolean {
	return (
		el.localName !== REGION &&
		(el.hasAttribute('data-ogygia-keep') || el.hasAttribute('data-persist'))
	);
}

/** A region whose subtree Svelte's reactivity owns (hydrated), or a kept island (it survives a
 *  navigation untouched) — matched by a morph, never entered. `data-hydrated` is only ever set on
 *  hyphenated roots, so its probe sits behind a cheap hyphen test. */
export function is_region_owned(el: Element): boolean {
	const name = el.localName;
	if (!name.includes('-')) return false;
	if (el.hasAttribute('data-hydrated')) return true;
	return name === REGION && el.hasAttribute('data-ogygia-keep');
}

/**
 * Who owns `el`. First match wins: `foreign` (declared) → `region` → `page` → `static` → `walk`.
 * `foreign` outranks `region` for plain elements only (a region never answers `foreign`), so a kept
 * island is `region` and a kept widget is `foreign`.
 */
export function owner_of(el: Element): Owner {
	if (is_declared_foreign(el)) return 'foreign';
	if (is_region_owned(el)) return 'region';
	if (el.localName === SLOT) return 'page';
	if (el.hasAttribute(OPAQUE_ATTR) || el.parentElement?.hasAttribute(HTML_PARENT_ATTR))
		return 'static';
	return 'walk';
}

/** True when Svelte's hydration walk binds `el`'s CHILDREN by position — the only subtrees the drift
 *  check and the repair keep in the server's shape. */
export function walk_enters(el: Element): boolean {
	return owner_of(el) === 'walk';
}

/**
 * An UPGRADED CUSTOM ELEMENT: a live web component whose own runtime owns its host. Detected
 * STRUCTURALLY — a hyphenated name with a shadow root or a registered definition — never by a
 * library-specific attribute. The ONE detection every writer uses (the morph's attribute skip and
 * self-owned children, the repair's conflict report).
 */
export function is_upgraded_ce(el: Element): boolean {
	const name = el.localName;
	if (!name.includes('-')) return false;
	if (el.shadowRoot) return true;
	return typeof customElements !== 'undefined' && customElements.get(name) !== undefined;
}

/**
 * An element whose CHILDREN are partly its own doing, not the render's: an upgraded custom element
 * (it slots / rewrites its light DOM), or a `<dialog>` / `<details>` whose `open` the browser flips.
 * A child it gave itself is `foreign` content inside a `walk`-owned element: the live morph keeps it;
 * the repair removes it only where Svelte's walk needs the position (and reports the conflict).
 */
export function is_self_owned(el: Element): boolean {
	const name = el.localName;
	return name === 'dialog' || name === 'details' || is_upgraded_ce(el);
}

// ── FACETS (internal/notes/dom-ownership.md §11) ────────────────────────────────────────────────
// `owner_of` answers who writes INSIDE an element. Three more questions have one answer each, here:
// who writes its ATTRIBUTES, who ORDERS its children, and whether a child EXISTS by the render's doing
// (the render may remove it when it stops producing it) or the element's (never removed).

/** Who writes an element's attributes: its own runtime (an upgraded custom element's host), Svelte's
 *  reactivity (a hydrated region root — but see {@link REGION_RENDER_ATTRS}), or the render. */
export function attributes_writer(el: Element): 'render' | 'element' | 'region' {
	// (an `<ogygia-region>` in any state: the runtime writes its state attributes — hydrated, kept,
	// nested — whether or not it woke yet)
	if (el.localName === REGION || is_region_owned(el)) return 'region';
	return is_upgraded_ce(el) ? 'element' : 'render';
}

/** The attributes of a region root that stay the render's: its ADDRESS, which the render that minted
 *  it writes (a re-minted hole fetches its new answer there); its content is its answer's. */
export const REGION_RENDER_ATTRS: readonly string[] = ['endpoint'];

/** Who orders an element's children: the render (positions are its sequence), or the element itself
 *  (a self-owned element relocates and wraps its light DOM — positions are not the render's). */
export function order_owner(el: Element): 'render' | 'element' {
	// (ogygia's own element never rearranges what it holds: a fallback, an answer — the render's order;
	// but a BAKED live region's content is hosted by Svelte's `{@html}`, whose anchor comments sit among
	// the answer's nodes: its children are partly another owner's, so it matches by identity)
	if (el.localName === REGION) return el.hasAttribute(BAKED_ATTR) ? 'element' : 'render';
	return is_self_owned(el) ? 'element' : 'render';
}

/** A live region whose first HTML was baked into the page by Svelte's `{@html}` (Region.svelte,
 *  PromiseRegionAwait): kept for the element's life — Svelte's block anchors stay among its children. */
export const BAKED_ATTR = 'data-og-baked';

/** The nodes ogygia placed under an element-ordered parent (a morph's claim or insertion, the restore
 *  putting Svelte's children back into a planned host). One per document across bundles: the inlined
 *  restorer fills the same set (`window.__og_rendered`). */
function rendered(): WeakSet<Node> {
	const w = globalThis as { __og_rendered?: WeakSet<Node> };
	return (w.__og_rendered ??= new WeakSet());
}

/** Record that the render placed `node` (it may remove it once the render stops producing it). */
export function mark_render_made(node: Node): void {
	rendered().add(node);
}

/**
 * Does `node`, a child of an element-ordered parent, EXIST by the render's doing? Marked by ogygia, or
 * structurally: an `<ogygia-region>` is always render output, and an element whose tag the render
 * produces at this level (`render_tags`) is render output — a runtime does not make the render's
 * elements. Anything else is the element's own: never matched, never removed.
 */
export function render_made(node: Node, render_tags: ReadonlySet<string>): boolean {
	if (rendered().has(node)) return true;
	if (node.nodeType !== 1) return false;
	const name = (node as Element).localName;
	return name === REGION || render_tags.has(name);
}
