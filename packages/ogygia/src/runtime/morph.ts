/**
 * # DOM morphing — reconcile a live element toward a freshly rendered region IN PLACE
 *
 * Live/held regions (`<ogygia-region live>`, `query.live` ticks, single-flight mutations) push new
 * server-rendered HTML every frame. Instead of tearing the old subtree down and rebuilding it, this
 * walks the OLD DOM and the NEW nodes together in a single pass and mutates the old tree the minimum
 * amount to reach the new shape. Nodes that can be reused keep their identity, so the browser keeps
 * focus, text selection, scroll position, typed-in form state, and running CSS transitions — the
 * LiveView "the page breathes" property.
 *
 * Inspired by natemoo-re/micromorph and idiomorph, trimmed to what ogygia needs and hardened with
 * real **keyed** matching (micromorph is index-aligned for body children).
 *
 * ## Algorithm (one pass, minimal allocations)
 * `morph_children(parent, new_nodes)` reconciles `parent`'s existing children toward `new_nodes`:
 *  1. Index the old children that carry a **key** (`data-key`, else `id`) into a map.
 *  2. Walk `new_nodes` left-to-right against a cursor over the old children:
 *     - **Keyed hit** — a new node's key matches an old node anywhere: move that old node into
 *       position and morph it. Reorders / inserts / removals morph in place instead of cascading
 *       replacements down the list.
 *     - **Id-set hit** — a key-less new element wants keys that a key-less old sibling holds (see
 *       "Wrapper matching" below): move that old sibling into position and morph it.
 *     - **Positional hit** — cursor node is compatible (same node kind + tag, both key-less): morph
 *       it and advance. Old keyed nodes reserved for a later key are skipped, never consumed here.
 *     - **Miss** — insert a fresh copy of the new node before the cursor.
 *  3. Remove every old node left unclaimed (trailing key-less nodes + unmatched keyed nodes).
 *
 * `morph_node(from, to)` reconciles one node against one node:
 *  - Text / comment: copy `nodeValue` in place.
 *  - Element, different tag or namespace: **replace** (`from` cannot become `to`).
 *  - Element, same tag: sync attributes, sync form DOM properties, recurse into children.
 *
 * ## State-preservation guarantees
 *  - **Identity** — a node that can be morphed is never replaced, so focus / selection / scroll /
 *    transitions on it and its subtree survive.
 *  - **Form state follows the server only when the server changed its mind** — the `value` /
 *    `checked` / `selected` PROPERTIES move only when the matching ATTRIBUTE differs between the
 *    previous render and the incoming one. A tick that re-sends the same default leaves what the
 *    user typed or toggled alone, focused or not (the browser's own dirty-value rule; htmx 4's morph
 *    rule). The control that currently holds focus is never touched at all, so mid-edit text and its
 *    selection survive even a changed default.
 *  - **Preserved subtrees** — an element marked `data-persist`, or a hydrated island root
 *    (`data-hydrated`), is kept exactly as-is: matched by key/position but never re-synced or
 *    recursed into. Islands own their DOM through Svelte reactivity (props push), not morphing, so
 *    this stops a live tick from re-creating a hydrated island root (the "hero bounce" reflow).
 *
 * ## Wrapper matching (id sets)
 * A key-less wrapper is matched by the keys INSIDE it (idiomorph's "id sets"). Before a pass, every
 * keyed descendant registers its key on each ancestor up to the morph root, on both trees. Two
 * key-less same-tag siblings then stay in lockstep only when their sets agree: both empty, or they
 * share a key (the same wrapper, re-rendered). Otherwise the remainder goes to the keyed phase, which
 * MOVES the old sibling holding the wanted keys into place — a banner appearing above an island's
 * wrapper no longer re-mounts the island — and refuses to consume an old wrapper a LATER new sibling
 * wants. When nothing better exists the match is positional, exactly as before; a tree with no keys
 * at all skips the whole mechanism.
 *
 * ## Namespaces
 * Clones are made with `importNode`, which carries the source namespace, so SVG / `foreignObject`
 * subtrees are created with the correct namespace. The morph-vs-replace test compares `namespaceURI`
 * as well as `tagName`, so an HTML `<a>` is never morphed into an SVG `<a>`.
 */
import { slots } from './slots.js';

// DOM spec constants by VALUE (they are frozen: 1/3/8 forever) — referencing the `Node` global
// at module scope made every importer of this file require a DOM at IMPORT time, which broke
// `ogygia/internal/reconcile` under plain node (found by verify:package, present since the
// module's birth). The functions still need a real DOM to DO anything; loading them doesn't.
const ELEMENT = 1; // Node.ELEMENT_NODE
const TEXT = 3; // Node.TEXT_NODE
const COMMENT = 8; // Node.COMMENT_NODE

/** Feature entry: fill the `morph` slot (live static-region ticks morph in place). */
export function install(): void {
	slots.morph = morph_children;
	// The navigation's body reconcile (./reconcile.ts) syncs attributes the same way, via the registry.
	slots.sync_attributes = sync_attributes;
}

/**
 * Reconcile `parent`'s children toward `new_nodes` (a freshly parsed, detached region). Public slot
 * shape: `(parent: Element, nodes: Node[]) => void` — a drop-in for the previous implementation.
 *
 * `new_nodes` is read but never mutated, so the recursion passes the incoming element's live
 * `childNodes` straight through (see {@link morph_node}) — no per-level array snapshot. Accessed by
 * index, so both a real `Array` (the top-level region) and a live `NodeList` (recursion) fit.
 *
 * Two phases:
 *  1. **Lockstep** — walk old and new in parallel while their keys agree (both `null` and compatible,
 *     or the same non-null key), morphing in place. This is the dominant tick (same structure, values
 *     changed) and it allocates NOTHING — no key map, no cursor bookkeeping. Reorders/inserts/removals
 *     break the lockstep at the first divergence and hand the REMAINDER to phase 2.
 *  2. **Keyed reconcile** — the general move/insert/remove algorithm, run only on the still-unmatched
 *     tail. The key map indexes just the remaining old children, so a change late in a long list still
 *     skips indexing the aligned prefix.
 */
export function morph_children(
	parent: Element,
	new_nodes: ArrayLike<Node>,
	options?: MorphOptions
): void {
	const preserve = options?.preserve_self_owned !== false;
	reconcile_children(parent, new_nodes, build_id_sets(parent, new_nodes), false, preserve);
	clear_aria_hidden_over_focus(parent);
}

/**
 * Two callers, two contracts.
 *
 * - **Live morph** (a hole re-answer, a router body swap, a live region tick) — `preserve_self_owned`
 *   on (the default): a self-owned element ({@link is_self_owned}) keeps the children it gave itself.
 *   The DOM stays live afterwards and a web component must not lose its own upgrade work.
 * - **Hydration repair** (an island restoring the server's node sequence before Svelte's walk) —
 *   `preserve_self_owned: false`: the target IS the server sequence, exactly. A child a runtime added
 *   inside a self-owned element is precisely the node Svelte's cursor trips on (`getAttribute is not
 *   a function` on a nested web component's own residue), so repair must be allowed to remove it.
 *   Self-owned ATTRIBUTES are still kept — the walk never reads them, and a `popover` the element gave
 *   itself is not what breaks hydration.
 */
export interface MorphOptions {
	preserve_self_owned?: boolean;
}

/**
 * WAI-ARIA safety net, run once after a morph settles: `aria-hidden="true"` must never sit on an
 * ancestor of the focused element — the browser blocks it and the interaction dies (an on-demand
 * dropdown, focused by the waking click, never opens because the morph stamped the region's fetched
 * closed state onto its container). aria-hidden reaches the focused subtree two ways: an in-place
 * attribute sync (guarded in {@link sync_attributes}) OR a freshly cloned/inserted subtree — importNode
 * copies attributes wholesale, with no guard, which is the path a REPLACED container takes. So the guard
 * alone was not enough. This sweep strips `aria-hidden="true"` from the focused element's ancestor chain
 * up to (and including) the morph root, covering both paths. A no-op unless focus lives inside `parent`.
 */
function clear_aria_hidden_over_focus(parent: Element): void {
	const doc = owner_document(parent);
	const active = doc.activeElement;
	if (active == null || active === doc.body || !parent.contains(active)) return;
	let n: Element | null = active;
	while (n) {
		if (n.getAttribute('aria-hidden') === 'true') n.removeAttribute('aria-hidden');
		if (n === parent) break;
		n = n.parentElement;
	}
}

/**
 * Element → the keys found among its DESCENDANTS (never its own key — that goes through the keyed
 * path). `null` when neither tree holds a key, so a key-less tick pays two scans and nothing else.
 * Built once per top-level morph and shared down the recursion. See "Wrapper matching" above.
 */
type IdSets = WeakMap<Element, Set<string>> | null;

const KEYED_SELECTOR = '[data-key],[id]';

function build_id_sets(parent: Element, new_nodes: ArrayLike<Node>): IdSets {
	let sets: IdSets = null;
	// Register `key` on every element from `start` up to (excluding) `stop`.
	const register = (key: string, start: Node | null, stop: Node | null): void => {
		for (let a = start; a !== null && a !== stop && a.nodeType === ELEMENT; a = a.parentNode) {
			let set = (sets ??= new WeakMap()).get(a as Element);
			if (set === undefined) sets.set(a as Element, (set = new Set()));
			set.add(key);
		}
	};
	for (const el of parent.querySelectorAll(KEYED_SELECTOR)) {
		const k = key_of(el);
		if (k !== null) register(k, el.parentNode, parent);
	}
	const count = new_nodes.length;
	for (let i = 0; i < count; i++) {
		const root = new_nodes[i];
		if (root.nodeType !== ELEMENT) continue;
		// A root is itself a sibling candidate, so its set carries its descendants' keys; whatever
		// sits above it (a parsed document, a fragment) is not part of this reconcile.
		for (const el of (root as Element).querySelectorAll(KEYED_SELECTOR)) {
			const k = key_of(el);
			if (k !== null) register(k, el.parentNode, root.parentNode);
		}
	}
	return sets;
}

/** Lockstep test for two key-less siblings: neither holds a key (nothing to protect), or they share
 *  one (the same wrapper, re-rendered). Anything else breaks lockstep so phase 2 can look around. */
function id_sets_agree(sets: NonNullable<IdSets>, a: Node, b: Node): boolean {
	if (a.nodeType !== ELEMENT) return true;
	const sa = sets.get(a as Element);
	const sb = sets.get(b as Element);
	if (sa === undefined) return sb === undefined;
	if (sb === undefined) return false;
	return intersects(sa, sb);
}

function intersects(a: Set<string>, b: Set<string>): boolean {
	if (a.size > b.size) [a, b] = [b, a];
	for (const k of a) if (b.has(k)) return true;
	return false;
}

/** The first remaining key-less old sibling that holds one of `wanted` and can become `next`. */
function find_holder(
	old_inner: Map<string, Element>,
	wanted: Set<string>,
	next: Node
): Element | null {
	for (const key of wanted) {
		const holder = old_inner.get(key);
		if (holder !== undefined && same_node(holder, next)) return holder;
	}
	return null;
}

/** `el` is consumed: it no longer holds anything for a later new sibling. */
function release_holder(
	old_inner: Map<string, Element>,
	sets: NonNullable<IdSets>,
	el: Element
): void {
	const held = sets.get(el);
	if (held === undefined) return;
	for (const key of held) if (old_inner.get(key) === el) old_inner.delete(key);
}

/** Does a new sibling AFTER `idx` want a key that `cursor` holds? Then `cursor` is spoken for. */
function reserved_for_later(
	sets: NonNullable<IdSets>,
	new_inner: Map<string, number> | null,
	cursor: ChildNode,
	idx: number
): boolean {
	if (new_inner === null) return false;
	const held = sets.get(cursor as Element);
	if (held === undefined) return false;
	for (const key of held) {
		const wanter = new_inner.get(key);
		if (wanter !== undefined && wanter > idx) return true;
	}
	return false;
}

/**
 * @param keep_children the parent is a self-owned element (an upgraded custom element / dialog / details,
 * {@link is_self_owned}) — so its children are partly ITS OWN doing (a web component slots and
 * rewrites its light DOM on upgrade). ADD + UPDATE what the render brings, but NEVER REMOVE a child the
 * element gave itself. Re-inserting/re-upgrading a live custom element is what makes an upgraded trigger
 * flicker when a hole morphs its byte-identical chrome; keeping its nodes leaves the upgrade untouched.
 * @param preserve the {@link MorphOptions.preserve_self_owned} contract, threaded unchanged down the
 * recursion — it decides whether a self-owned DESCENDANT gets `keep_children` at all.
 */
function reconcile_children(
	parent: Element,
	new_nodes: ArrayLike<Node>,
	sets: IdSets,
	keep_children = false,
	preserve = true
): void {
	const count = new_nodes.length;
	let cursor: ChildNode | null = parent.firstChild;
	let idx = 0;

	// ── Phase 1: optimistic lockstep ────────────────────────────────────────────
	while (idx < count && cursor) {
		const next = new_nodes[idx];
		const ck = key_of(cursor);
		const nk = key_of(next);
		// Keys must agree to stay in lockstep.
		if (ck !== nk) break;
		if (nk === null) {
			// Both key-less: the tags must match too. `same_node` having passed means morph_same can
			// skip re-deciding morph-vs-replace (that check would only re-confirm the same verdict).
			if (!same_node(cursor, next)) break;
			// Wrapper matching: two key-less wrappers stay in lockstep only while their id sets agree.
			// A disagreement (one holds keys the other doesn't) hands the remainder to phase 2, which
			// builds the sibling indexes needed to tell whether something better exists.
			if (sets !== null && !id_sets_agree(sets, cursor, next)) break;
			const here = cursor;
			cursor = cursor.nextSibling;
			morph_same(here, next, sets, preserve);
		} else {
			// Same non-null key: morph regardless of tag (morph_node replaces on a tag mismatch).
			const here = cursor;
			cursor = cursor.nextSibling;
			morph_node(here, next, sets, preserve);
		}
		idx++;
	}

	// Aligned all the way: drop any old tail the new shape dropped, and we're done — no map built.
	// A self-owned parent keeps its own trailing children (they are not the render's to remove).
	if (idx >= count) {
		if (!keep_children) {
			while (cursor) {
				const gone = cursor;
				cursor = cursor.nextSibling;
				parent.removeChild(gone);
			}
		}
		return;
	}
	// Old ran out first: everything left is a pure append.
	if (cursor === null) {
		for (; idx < count; idx++) parent.insertBefore(clone(new_nodes[idx]), null);
		return;
	}

	// ── Phase 2: keyed reconcile of the remainder [cursor.. ] vs new_nodes[idx.. ] ──
	// Index the still-unmatched old children: keyed ones by key, and (wrapper matching) key-less
	// ones by the keys they hold — first holder wins, like the DOM's own `getElementById`.
	let old_keys: Map<string, ChildNode> | null = null;
	let old_inner: Map<string, Element> | null = null;
	for (let n: ChildNode | null = cursor; n; n = n.nextSibling) {
		const k = key_of(n);
		if (k !== null) {
			(old_keys ??= new Map()).set(k, n);
		} else if (sets !== null && n.nodeType === ELEMENT) {
			const held = sets.get(n as Element);
			if (held !== undefined) {
				old_inner ??= new Map();
				for (const key of held) if (!old_inner.has(key)) old_inner.set(key, n as Element);
			}
		}
	}
	// Which remaining NEW sibling first wants each key — only needed to tell whether an old wrapper
	// is reserved for a later new sibling, so only built when an old wrapper holds keys at all.
	let new_inner: Map<string, number> | null = null;
	if (old_inner !== null) {
		for (let i = idx; i < count; i++) {
			const n = new_nodes[i];
			if (n.nodeType !== ELEMENT || key_of(n) !== null) continue;
			const wanted = sets!.get(n as Element);
			if (wanted === undefined) continue;
			new_inner ??= new Map();
			for (const key of wanted) if (!new_inner.has(key)) new_inner.set(key, i);
		}
	}

	if (old_keys === null && old_inner === null) {
		// No keyed old children left and no wrapper holds a key: purely positional (the cursor's
		// key is never in play).
		for (; idx < count; idx++) {
			const next = new_nodes[idx];
			if (cursor && key_of(next) === null && same_node(cursor, next)) {
				const here = cursor;
				cursor = cursor.nextSibling;
				morph_same(here, next, sets, preserve);
			} else {
				parent.insertBefore(clone(next), cursor);
			}
		}
	} else {
		for (; idx < count; idx++) {
			const next = new_nodes[idx];
			const next_key = key_of(next);

			if (next_key !== null) {
				// Keyed hit: reuse the old node with this key wherever it currently sits (one map probe).
				const matched = old_keys?.get(next_key);
				if (matched !== undefined) {
					old_keys!.delete(next_key);
					if (matched === cursor) {
						cursor = cursor.nextSibling;
					} else {
						parent.insertBefore(matched, cursor); // moves `matched` (already lives in `parent`)
					}
					morph_node(matched, next, sets, preserve);
					continue;
				}
			} else if (old_inner !== null && next.nodeType === ELEMENT) {
				// Id-set hit: a key-less wrapper wanting keys a key-less old sibling holds — reuse that
				// sibling wherever it sits, so the keyed subtree inside it (an island) keeps its identity.
				const wanted = sets!.get(next as Element);
				const holder = wanted === undefined ? null : find_holder(old_inner, wanted, next);
				if (holder !== null) {
					release_holder(old_inner, sets!, holder);
					if (holder === cursor) {
						cursor = cursor.nextSibling;
					} else {
						parent.insertBefore(holder, cursor);
					}
					morph_same(holder, next, sets, preserve);
					continue;
				}
			}

			// Walk the cursor to the next slot, skipping old keyed nodes reserved for a later key —
			// computing each candidate's key exactly once (reused by the positional test below).
			let cur_key: string | null = null;
			while (cursor) {
				cur_key = key_of(cursor);
				if (cur_key === null || old_keys === null || !old_keys.has(cur_key)) break; // not reserved
				cursor = cursor.nextSibling;
			}

			// Positional hit: a key-less, compatible node in this slot morphs in place — unless a LATER
			// new sibling wants keys this old wrapper holds (then it waits there for that sibling).
			if (
				cursor &&
				next_key === null &&
				cur_key === null &&
				same_node(cursor, next) &&
				(old_inner === null || !reserved_for_later(sets!, new_inner, cursor, idx))
			) {
				const here = cursor;
				cursor = cursor.nextSibling;
				if (old_inner !== null) release_holder(old_inner, sets!, here as Element);
				morph_same(here, next, sets, preserve);
				continue;
			}

			// Miss: nothing here can become `next` — insert a fresh copy before the cursor.
			parent.insertBefore(clone(next), cursor);
		}
	}

	// Remove everything the new shape did not claim — UNLESS the parent is self-owned, whose extra
	// children are its own (a foreign custom element's slotted / upgraded light DOM). See keep_children.
	if (!keep_children) {
		// Trailing key-less/unmatched nodes from the cursor onward:
		while (cursor) {
			const gone = cursor;
			cursor = cursor.nextSibling;
			parent.removeChild(gone);
		}
		// Keyed nodes whose key vanished but that sit BEFORE the cursor (positionally skipped):
		if (old_keys) {
			for (const node of old_keys.values()) {
				if (node.parentNode === parent) parent.removeChild(node);
			}
		}
	}
}

/**
 * The morph key of a node: `data-key` (explicit), else `id`, else `null` (unkeyed → positional).
 * Uses the reflected `.id` property (a direct field read) instead of `getAttribute('id')`, and only
 * probes `data-key` — so the overwhelmingly common key-less element costs one attribute lookup.
 */
function key_of(node: Node): string | null {
	if (node.nodeType !== ELEMENT) return null;
	const el = node as Element;
	const dk = el.getAttribute('data-key');
	if (dk !== null) return dk;
	const id = el.id;
	return id !== '' ? id : null;
}

/** Same slot for positional reuse: same node kind, and (for elements) same tag + namespace. */
function same_node(a: Node, b: Node): boolean {
	if (a.nodeType !== b.nodeType) return false;
	if (a.nodeType === ELEMENT) {
		return (
			(a as Element).tagName === (b as Element).tagName &&
			(a as Element).namespaceURI === (b as Element).namespaceURI
		);
	}
	return true; // text / comment reconcile positionally
}

/** A subtree that must be kept intact: user-marked persist, or a hydrated (Svelte-owned) island root. */
function is_preserved(el: Element): boolean {
	// `data-persist` and `data-ogygia-keep` are general user markers (any tag) — always probed; a
	// matched keep-node is kept intact across a nav reconcile (this is what makes the morph path
	// subsume persist's relocate). `data-hydrated` is only ever set on hyphenated custom-element
	// roots (`<ogygia-region>` / `<ogygia-island>`), so its probe is gated behind a cheap `localName`
	// hyphen test — an ordinary `<td>` never pays for it.
	return (
		el.hasAttribute('data-persist') ||
		el.hasAttribute('data-ogygia-keep') ||
		(el.localName.includes('-') && el.hasAttribute('data-hydrated'))
	);
}

/**
 * An UPGRADED CUSTOM ELEMENT: a live web component whose own runtime owns its host. On upgrade a
 * component framework writes framework-internal attributes onto its own host element — a scope class,
 * hydration ids, `popover` / `role` / `aria-*`, a `hydrated` flag — none of which came from the
 * server render and none of which are the render's to assert. This is generic: any web-component
 * framework (or a hand-written element) that adopts declarative shadow DOM or upgrades in place does
 * it. Detected STRUCTURALLY — a hyphenated name with a shadow root or a registered definition — never
 * by a library-specific attribute or class name.
 *
 * Two consequences for a morph toward a fresh server render (which carries the PRE-upgrade markup):
 *  - the host's CHILDREN are partly its own (slotted / rewritten light DOM) → add + update, never
 *    remove ({@link is_self_owned} → keep_children);
 *  - the host's own ATTRIBUTES are the runtime's → do not sync them at all. Re-asserting a fresh
 *    render's stale markers over a live host makes it lose its hydrated shadow and re-render — a live
 *    host duplicated its content when a hole answer's per-render id / scope class overwrote the ones
 *    its runtime had written. So {@link morph_node} / {@link morph_same} SKIP {@link sync_attributes}
 *    for an upgraded custom element (its children still reconcile).
 */
function is_upgraded_ce(el: Element): boolean {
	const name = el.localName;
	if (!name.includes('-')) return false;
	if (el.shadowRoot) return true;
	return typeof customElements !== 'undefined' && customElements.get(name) !== undefined;
}

/**
 * An element whose CHILDREN are partly its own doing, not the render's: an upgraded custom element
 * (slots / rewrites its light DOM — {@link is_upgraded_ce}), or a `<dialog>` / `<details>` whose
 * `open` the browser flips. A morph toward server HTML must never REMOVE such children (keep_children)
 * — re-inserting a live web component's chrome is what made an upgraded trigger flicker.
 * Unlike an upgraded custom element, a dialog/details carries NO runtime-written markers, so its
 * attributes still sync normally (add + update, `open` kept by keep_extra).
 */
function is_self_owned(el: Element): boolean {
	const name = el.localName;
	return name === 'dialog' || name === 'details' || is_upgraded_ce(el);
}

/**
 * Reconcile a single old node toward a single new node, replacing only when it cannot be morphed.
 * Used by keyed matches, where `from` and `to` may be different tags (the reason the tag/namespace
 * replace check lives here). Positional/lockstep callers have already proven compatibility via
 * {@link same_node} and go through {@link morph_same}, skipping that recheck.
 */
function morph_node(from: Node, to: Node, sets: IdSets, preserve: boolean): void {
	const kind = from.nodeType;
	// Text / comment: cheapest possible update.
	if (kind === TEXT || kind === COMMENT) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	if (kind !== ELEMENT) return;

	const ef = from as Element;
	const et = to as Element;

	// Can't turn one element into a different element — hand the whole node over.
	if (ef.tagName !== et.tagName || ef.namespaceURI !== et.namespaceURI) {
		ef.parentNode?.replaceChild(clone(to), ef);
		return;
	}
	// Hydrated island / persisted node: Svelte owns it. Match it, but never touch it.
	if (is_preserved(ef)) return;
	// Form props BEFORE attributes: the rule compares the previous render's attribute to the incoming
	// one, so it must read `ef`'s attributes while they are still the previous render's.
	const self_owned = is_self_owned(ef);
	sync_form_props(ef, et);
	// An upgraded custom element's host attributes are the runtime's, not the render's — skip them
	// entirely (see is_upgraded_ce). Everything else (incl. a self-owned dialog/details) syncs.
	if (!is_upgraded_ce(ef)) sync_attributes(ef, et, self_owned);
	// `et` is never mutated by the recursion (misses clone, keyed moves come from the OLD tree), so
	// its live `childNodes` is handed straight down — no per-level snapshot array.
	reconcile_children(ef, et.childNodes, sets, preserve && self_owned, preserve);
}

/**
 * Reconcile two nodes already known to be the same kind + (for elements) same tag + namespace — the
 * positional/lockstep path. Skips the morph-vs-replace decision {@link morph_node} makes; the element
 * body is inlined (not shared via a helper) to keep this leaf call one frame deep on the hot path.
 */
function morph_same(from: Node, to: Node, sets: IdSets, preserve: boolean): void {
	const kind = from.nodeType;
	if (kind === TEXT || kind === COMMENT) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	if (kind !== ELEMENT) return;
	const ef = from as Element;
	if (is_preserved(ef)) return;
	const et = to as Element;
	const self_owned = is_self_owned(ef);
	sync_form_props(ef, et); // before attributes — see morph_node
	if (!is_upgraded_ce(ef)) sync_attributes(ef, et, self_owned); // upgraded host attrs are the runtime's — skip
	reconcile_children(ef, et.childNodes, sets, preserve && self_owned, preserve);
}

/** Add + update + remove attributes so `from` matches `to` exactly. Boolean attrs are attr presence.
 *  `keep_extra` (a self-owned element, {@link is_self_owned}): add + update only — an attribute the
 *  element gave itself is not the render's to take away. */
export function sync_attributes(from: Element, to: Element, keep_extra = false): void {
	const to_attrs = to.attributes;
	const to_len = to_attrs.length;
	// Add / update everything `to` wants. After this, `from`'s attribute names are a superset of
	// `to`'s (every `to` name is now present on `from`).
	for (let i = 0; i < to_len; i++) {
		const attr = to_attrs[i];
		if (from.getAttribute(attr.name) === attr.value) continue;
		// WAI-ARIA: `aria-hidden="true"` must not sit on an ancestor of the focused element — the
		// browser blocks it and the interaction dies. The morph fetched this region's closed/default
		// state (an on-demand dropdown's SSR render), so stamping its aria-hidden over a subtree the
		// user just focused open would hide the panel they're opening. Skip it; the live, focused branch
		// stays authoritative (like the focused form control does in sync_form_props) until it blurs
		// and a later tick re-applies. Cheap: the focus probe runs only for this one attribute.
		if (attr.name === 'aria-hidden' && attr.value === 'true' && subtree_has_focus(from)) continue;
		from.setAttribute(attr.name, attr.value);
	}
	// `from` can only carry a stale attribute if it has MORE attributes than `to` — otherwise the
	// superset above is an exact match and the whole removal scan (+ its hasAttribute probes) is
	// skipped, which is the common "same attribute set, values churn" tick.
	if (keep_extra) return;
	const from_attrs = from.attributes;
	if (from_attrs.length > to_len) {
		// Iterate backwards — removal shifts the live list.
		for (let i = from_attrs.length - 1; i >= 0; i--) {
			const name = from_attrs[i].name;
			if (!to.hasAttribute(name)) from.removeAttribute(name);
		}
	}
}

/**
 * Sync live form DOM *properties* (`value` / `checked` / `selected`) — attributes alone don't move
 * these once a control is dirty. Runs BEFORE {@link sync_attributes}, because the rule is "follow
 * the server only when the server changed its default": a property moves only when its attribute
 * differs between the PREVIOUS render (still on `from`) and the incoming one (on `to`). A tick that
 * re-sends the same default never clobbers what the user typed or toggled in a field they have since
 * left — the browser's own dirty-value rule, and htmx 4's morph rule. The focused control is skipped
 * outright so a live tick never touches what the user is typing (its selection is left alone too).
 */
function sync_form_props(from: Element, to: Element): void {
	const tag = from.tagName;
	if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'OPTION') return;

	// The control the user is actively editing stays authoritative over its own value/checked.
	if (owner_document(from)?.activeElement === from) return;

	const ff = from as HTMLInputElement;

	// `value`: only an incoming node that *explicitly* carries a value attribute, and one that differs
	// from the previous render's, moves the property. Re-rendering WITHOUT a value attribute, or with
	// the same one, leaves text a user typed (or any programmatic value) alone.
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
		const next = to.getAttribute('value');
		if (next !== null && next !== from.getAttribute('value') && ff.value !== next) ff.value = next;
	}
	// `checked` / `selected`: attribute presence is the server's default; the property follows it
	// only when that presence flipped between renders.
	if (tag === 'INPUT') {
		const next = to.hasAttribute('checked');
		if (next !== from.hasAttribute('checked') && ff.checked !== next) ff.checked = next;
	}
	if (tag === 'OPTION') {
		const of = from as unknown as HTMLOptionElement;
		const next = to.hasAttribute('selected');
		if (next !== from.hasAttribute('selected') && of.selected !== next) of.selected = next;
	}
}

/** `importNode(node, true)` — a deep copy owned by this document, carrying the source namespace. */
function clone(node: Node): Node {
	return owner_document(node).importNode(node, true);
}

/** The owning document, falling back to the ambient `document` for detached nodes. */
function owner_document(node: Node): Document {
	return node.ownerDocument ?? document;
}

/** True when the currently focused element lives inside `el` — so putting `aria-hidden="true"` on `el`
 *  would hide the focused subtree (a WAI-ARIA violation the browser blocks). `activeElement` is `<body>`
 *  when nothing has focus, which no morphed subtree contains, so that reads as false. */
function subtree_has_focus(el: Element): boolean {
	const doc = owner_document(el);
	const active = doc.activeElement;
	return active != null && active !== doc.body && el.contains(active);
}
