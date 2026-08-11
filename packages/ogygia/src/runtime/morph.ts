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
 *  - **Focused control is authoritative** — `value` / `checked` / `selected` are synced from the
 *    incoming node so programmatic form state stays correct, EXCEPT on the element that currently
 *    holds focus: the control the user is actively editing is never clobbered mid-tick, and its text
 *    selection is left untouched. (The old morph never synced these at all; syncing non-focused
 *    controls is the strict improvement, the focus carve-out keeps the "don't clobber typing" rule.)
 *  - **Preserved subtrees** — an element marked `data-persist`, or a hydrated island root
 *    (`data-hydrated`), is kept exactly as-is: matched by key/position but never re-synced or
 *    recursed into. Islands own their DOM through Svelte reactivity (props push), not morphing, so
 *    this stops a live tick from re-creating a hydrated island root (the "hero bounce" reflow).
 *
 * ## Namespaces
 * Clones are made with `importNode`, which carries the source namespace, so SVG / `foreignObject`
 * subtrees are created with the correct namespace. The morph-vs-replace test compares `namespaceURI`
 * as well as `tagName`, so an HTML `<a>` is never morphed into an SVG `<a>`.
 */
import { slots } from './slots.js';

const ELEMENT = Node.ELEMENT_NODE;
const TEXT = Node.TEXT_NODE;
const COMMENT = Node.COMMENT_NODE;

/** Feature entry: fill the `morph` slot (live static-region ticks morph in place). */
export function install(): void {
	slots.morph = morph_children;
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
export function morph_children(parent: Element, new_nodes: ArrayLike<Node>): void {
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
			const here = cursor;
			cursor = cursor.nextSibling;
			morph_same(here, next);
		} else {
			// Same non-null key: morph regardless of tag (morph_node replaces on a tag mismatch).
			const here = cursor;
			cursor = cursor.nextSibling;
			morph_node(here, next);
		}
		idx++;
	}

	// Aligned all the way: drop any old tail the new shape dropped, and we're done — no map built.
	if (idx >= count) {
		while (cursor) {
			const gone = cursor;
			cursor = cursor.nextSibling;
			parent.removeChild(gone);
		}
		return;
	}
	// Old ran out first: everything left is a pure append.
	if (cursor === null) {
		for (; idx < count; idx++) parent.insertBefore(clone(new_nodes[idx]), null);
		return;
	}

	// ── Phase 2: keyed reconcile of the remainder [cursor.. ] vs new_nodes[idx.. ] ──
	// Index only the still-unmatched keyed old children.
	let old_keys: Map<string, ChildNode> | null = null;
	for (let n: ChildNode | null = cursor; n; n = n.nextSibling) {
		const k = key_of(n);
		if (k !== null) (old_keys ??= new Map()).set(k, n);
	}

	if (old_keys === null) {
		// No keyed old children left: purely positional (the cursor's key is never in play).
		for (; idx < count; idx++) {
			const next = new_nodes[idx];
			if (cursor && key_of(next) === null && same_node(cursor, next)) {
				const here = cursor;
				cursor = cursor.nextSibling;
				morph_same(here, next);
			} else {
				parent.insertBefore(clone(next), cursor);
			}
		}
	} else {
		for (; idx < count; idx++) {
			const next = new_nodes[idx];
			const next_key = key_of(next);

			// Keyed hit: reuse the old node with this key wherever it currently sits (one map probe).
			if (next_key !== null) {
				const matched = old_keys.get(next_key);
				if (matched !== undefined) {
					old_keys.delete(next_key);
					if (matched === cursor) {
						cursor = cursor.nextSibling;
					} else {
						parent.insertBefore(matched, cursor); // moves `matched` (already lives in `parent`)
					}
					morph_node(matched, next);
					continue;
				}
			}

			// Walk the cursor to the next slot, skipping old keyed nodes reserved for a later key —
			// computing each candidate's key exactly once (reused by the positional test below).
			let cur_key: string | null = null;
			while (cursor) {
				cur_key = key_of(cursor);
				if (cur_key === null || !old_keys.has(cur_key)) break; // not reserved
				cursor = cursor.nextSibling;
			}

			// Positional hit: a key-less, compatible node in this slot morphs in place.
			if (cursor && next_key === null && cur_key === null && same_node(cursor, next)) {
				const here = cursor;
				cursor = cursor.nextSibling;
				morph_same(here, next);
				continue;
			}

			// Miss: nothing here can become `next` — insert a fresh copy before the cursor.
			parent.insertBefore(clone(next), cursor);
		}
	}

	// Remove everything the new shape did not claim.
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
	// `data-persist` is a general user marker (any tag), so it is always probed. `data-hydrated` is
	// only ever set on hyphenated custom-element roots (`<ogygia-region>` / `<ogygia-island>`), so its
	// probe is gated behind a cheap `localName` hyphen test — an ordinary `<td>` never pays for it.
	return el.hasAttribute('data-persist') || (el.localName.includes('-') && el.hasAttribute('data-hydrated'));
}

/**
 * Reconcile a single old node toward a single new node, replacing only when it cannot be morphed.
 * Used by keyed matches, where `from` and `to` may be different tags (the reason the tag/namespace
 * replace check lives here). Positional/lockstep callers have already proven compatibility via
 * {@link same_node} and go through {@link morph_same}, skipping that recheck.
 */
function morph_node(from: Node, to: Node): void {
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
	sync_attributes(ef, et);
	sync_form_props(ef, et);
	// `et` is never mutated by the recursion (misses clone, keyed moves come from the OLD tree), so
	// its live `childNodes` is handed straight down — no per-level snapshot array.
	morph_children(ef, et.childNodes);
}

/**
 * Reconcile two nodes already known to be the same kind + (for elements) same tag + namespace — the
 * positional/lockstep path. Skips the morph-vs-replace decision {@link morph_node} makes; the element
 * body is inlined (not shared via a helper) to keep this leaf call one frame deep on the hot path.
 */
function morph_same(from: Node, to: Node): void {
	const kind = from.nodeType;
	if (kind === TEXT || kind === COMMENT) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	if (kind !== ELEMENT) return;
	const ef = from as Element;
	if (is_preserved(ef)) return;
	const et = to as Element;
	sync_attributes(ef, et);
	sync_form_props(ef, et);
	morph_children(ef, et.childNodes);
}

/** Add + update + remove attributes so `from` matches `to` exactly. Boolean attrs are attr presence. */
function sync_attributes(from: Element, to: Element): void {
	const to_attrs = to.attributes;
	const to_len = to_attrs.length;
	// Add / update everything `to` wants. After this, `from`'s attribute names are a superset of
	// `to`'s (every `to` name is now present on `from`).
	for (let i = 0; i < to_len; i++) {
		const attr = to_attrs[i];
		if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
	}
	// `from` can only carry a stale attribute if it has MORE attributes than `to` — otherwise the
	// superset above is an exact match and the whole removal scan (+ its hasAttribute probes) is
	// skipped, which is the common "same attribute set, values churn" tick.
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
 * these once a control is dirty. The focused control is skipped so a live tick never clobbers what
 * the user is typing (its selection is left untouched too).
 */
function sync_form_props(from: Element, to: Element): void {
	const tag = from.tagName;
	if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'OPTION') return;

	// The control the user is actively editing stays authoritative over its own value/checked.
	if (owner_document(from)?.activeElement === from) return;

	const ff = from as HTMLInputElement;
	const ft = to as HTMLInputElement;

	// `value` follows the server only when the incoming node *explicitly* carries one. A live tick
	// that re-renders a control WITHOUT a value attribute leaves the live property alone, so text a
	// user typed (or any programmatic value) survives a reorder / breathing update — matching the old
	// morph's "never clobber typed input" rule while still honouring an explicit server value.
	if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && to.hasAttribute('value')) {
		if (ff.value !== ft.value) ff.value = ft.value;
	}
	// `checked` is a boolean: attribute presence/absence is itself the authoritative state.
	if (tag === 'INPUT' && ff.checked !== ft.checked) ff.checked = ft.checked;
	if (tag === 'OPTION') {
		const of = from as unknown as HTMLOptionElement;
		const ot = to as unknown as HTMLOptionElement;
		if (of.selected !== ot.selected) of.selected = ot.selected;
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
