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
import { emit as dt_emit } from '../devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

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
 */
function repair_markup(region: HTMLElement, want: Element): void {
	if (align_to(region, want)) return;
	const nodes = Array.from(want.childNodes);
	const morph = slots.morph;
	if (morph) morph(region, nodes);
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
function sequence_differs(live: Node, want: Node): boolean {
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
function repair_if_drifted(
	region: HTMLElement,
	ssr_html: string
): { repaired: boolean; reason: string | null } {
	const holder = document.createElement('template');
	holder.innerHTML = ssr_html; // inert: nothing upgrades in a template's content
	// The copy under a region of its own — in the template's inert document, so the element never
	// upgrades — lifted by the very routine that lifted the live island (what it leaves in a lake,
	// it leaves in both).
	const want = holder.content.ownerDocument.createElement('ogygia-region');
	want.appendChild(holder.content);
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
			if (morph) morph(live_elements[i], Array.from(want_elements[i].childNodes));
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
		try {
			out = quietly(() => attempt(false));
			healed = repaired;
		} catch {
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
					`and re-rendered client-side (Svelte hydration-mismatch recovery). Something changed this ` +
					`region's HTML between SSR and wake — a post-SSR transform (transformPageChunk / an ` +
					`HTML-rewriting middleware), an A/B-testing snippet, or an edge rewriter. Whatever that ` +
					`step injected (e.g. declarative shadow DOM) was just destroyed, and the swap is ` +
					`timing-dependent, so symptoms look erratic.` +
					(drift.reason ? `\nWhat changed: ${drift.reason}` : '') +
					`\nFix: make the mutation invisible to hydration (mutate only <head>, attributes, or ` +
					`shadow templates — never the region's light DOM), or freeze the foreign-owned subtree ` +
					`with a wake:'none' (lake) boundary.`
			);
		}
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
