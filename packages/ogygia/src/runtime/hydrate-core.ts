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

/** Svelte's hydrate with `recover: false` throws `hydration_failed` on a mismatch: in dev the
 *  message starts with the code, in production it is the bare `https://svelte.dev/e/<code>` URL. */
const HYDRATION_FAILED_RE = /hydration_failed/;

/** The hydration ENVELOPE: `hydrate()` anchors on a top-level `<!--[-->` comment and then expects
 *  the component's OWN region envelope — but embedded SSR (Region.svelte) emits only the inner
 *  layer. Idempotent: a repair from the server markup drops it, the next attempt puts it back. */
function ensure_envelope(region: Element): void {
	if (has_envelope(region)) return;
	region.insertBefore(document.createComment('['), region.firstChild);
	region.appendChild(document.createComment(']'));
}
function has_envelope(region: Element): boolean {
	const first = region.firstChild;
	return !!first && first.nodeType === 8 && (first as Comment).data === '[';
}
/** Take the envelope off again — the server markup the element kept has none, so a comparison
 *  or a repair against it must see the island as the server sent it. */
function strip_envelope(region: Element): void {
	if (!has_envelope(region)) return;
	region.firstChild!.remove();
	const last = region.lastChild;
	if (last && last.nodeType === 8 && (last as Comment).data === ']') last.remove();
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
function repair_markup(region: HTMLElement, ssr_html: string): void {
	strip_envelope(region);
	const holder = document.createElement('template');
	holder.innerHTML = ssr_html; // inert: nothing upgrades in a template's content
	if (align_to(region, holder.content)) return;
	const morph = slots.morph;
	if (morph) morph(region, Array.from(holder.content.childNodes));
	else region.innerHTML = ssr_html;
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

	let lifted: LiftedLake[] | null = slots.lakes.lift(region);
	try {
		if (!region.isConnected) return null;
		// FOREIGN-MUTATION DETECTOR (arm): a successful hydration CLAIMS the server-rendered nodes —
		// they stay in the region. Svelte 5's mismatch recovery instead silently discards them and
		// re-renders fresh, which reads as success here while the SSR content (and anything a
		// post-SSR transform injected into it — declarative shadow DOM, A/B edits) is destroyed.
		// Remember the SSR element children (post-lake-lift) so the check below can tell a claim
		// from a recovery. See internal/notes/foreign-dom.md.
		let ssr_children = Array.from(region.children);

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

		// THE HYDRATION SOURCE OF TRUTH is the island's server markup, not whatever the live DOM is
		// now. An island can sleep for a long time (`visible`, `interaction`), and other scripts edit
		// the page meanwhile — a design-system runtime stripping whitespace text nodes while it
		// "hydrates" the header around it, an A/B tool, a translator. Svelte's walk then meets a
		// different node sequence and, left to itself, throws the server DOM away and re-renders the
		// island client-side: a flash, DSD/foreign content destroyed, and the tap that woke the
		// island replayed onto a discarded node (a login dropdown needed two clicks). So:
		//   1. hydrate with recovery OFF;
		//   2. on a mismatch, if the live markup differs from the server markup the element kept at
		//      connect, put the server markup back and hydrate THAT — it matches by construction;
		//   3. only if that fails too (or nothing drifted: the component itself threw), let Svelte
		//      recover the way it always did, and the detector below reports the discard.
		let out: IslandHandle;
		let healed = false;
		try {
			out = quietly(() => attempt(false));
		} catch (first) {
			const mismatch = first instanceof Error && HYDRATION_FAILED_RE.test(first.message);
			// Drift is measured on the island as the server sent it — the failed attempt's envelope
			// comments are not the server's, so they come off before the comparison.
			if (mismatch && ssr_html !== null) strip_envelope(region);
			const drifted = mismatch && ssr_html !== null && region.innerHTML !== ssr_html;
			if (drifted) {
				repair_markup(region, ssr_html!);
				// The lakes inside came back with their server children: lift them again (the earlier
				// lift holds nodes that are no longer in the tree) so the walk sees them as before.
				lifted = slots.lakes.lift(region);
				ssr_children = Array.from(region.children);
				try {
					out = quietly(() => attempt(false));
					healed = true;
				} catch {
					out = attempt(true);
				}
			} else {
				out = attempt(true);
			}
		}
		if (healed) {
			region.setAttribute('data-og-healed', '');
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.healed',
					entry,
					fp: region.getAttribute('data-og-fp') || undefined
				});
			if (import.meta.env.DEV) console.warn(HEALED_WARNING, entry);
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
			region.setAttribute('data-og-recovered', '');
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.recovered',
					entry,
					fp: region.getAttribute('data-og-fp') || undefined
				});
			console.warn(
				`[ogygia] island "${entry}" discarded its ENTIRE server-rendered DOM during hydration ` +
					`and re-rendered client-side (Svelte hydration-mismatch recovery). Something changed this ` +
					`region's HTML between SSR and wake — a post-SSR transform (transformPageChunk / an ` +
					`HTML-rewriting middleware), an A/B-testing snippet, or an edge rewriter. Whatever that ` +
					`step injected (e.g. declarative shadow DOM) was just destroyed, and the swap is ` +
					`timing-dependent, so symptoms look erratic. Fix: make the mutation invisible to hydration ` +
					`(mutate only <head>, attributes, or shadow templates — never the region's light DOM), or ` +
					`freeze the foreign-owned subtree with a wake:'none' (lake) boundary.`
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
