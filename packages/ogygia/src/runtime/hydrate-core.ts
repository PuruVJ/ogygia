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
import { is_deferred, inside_frozen, region_ssr_truncated } from './region-attrs.js';
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

/** An island's loaded module: the component, plus a foreign build's own hydrate contract. */
export type IslandModule = {
	default: Component<Record<string, unknown>>;
	__og_hydrate?: (target: Element, props: Record<string, unknown>) => unknown;
	__og_unmount?: (app: unknown) => void;
};

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
	mod: IslandModule
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

	// Mixed mode: on a csr=true page Kit already hydrates this component — skip. EXCEPT a deferred
	// region (server island / <Region>): its HTML was FETCHED after load and swapped in, so it was
	// never part of Kit's SSR tree — Kit didn't hydrate it and won't. We must. (connectedCallback
	// carries the same is_deferred exception for the fetch phase.) And EXCEPT a region INSIDE A
	// LAKE: the lake wrapper adopts its SSR element under Kit as opaque DOM, so Kit never hydrates
	// the islands in there either — those are ours.
	if (kit_hydrates_page() && !is_deferred(region) && !inside_frozen(region)) {
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
		const ssr_children = Array.from(region.children);

		// FOREIGN delegation (fragment federation): the entry came from another build/origin and
		// exports its own `__og_hydrate` — envelope preparation belongs to the svelte that compiled
		// the entry, so the consumer must not shape it.
		const foreign_delegate = foreign && typeof mod.__og_hydrate === 'function';

		// Hydration envelope: `hydrate()` anchors on a top-level `<!--[-->` comment and then expects
		// the component's OWN region envelope — but embedded SSR (Region.svelte) emits only the inner
		// layer. `render()` (region endpoint / deferred swap) has BOTH layers — do not wrap again or
		// hydration mismatches. (Verified against svelte 5.56.)
		if (!is_deferred(region) && !foreign_delegate) {
			region.insertBefore(document.createComment('['), region.firstChild);
			region.appendChild(document.createComment(']'));
		}

		// Hydrate through NestedProvider so descendants see the "inside a hydrated island" context —
		// any nested island wrapper then degrades to a plain inline component (single hydration with
		// this parent). The provider adds no DOM, so this matches SSR.
		let out: IslandHandle;
		set_current_region(region);
		try {
			// Foreign islands take RAW props: the dev mutation-guard proxy is THIS build's code running
			// inside another build's render — harmless, but it's a wire, and we don't cross wires.
			// (Plain data either way; the parse membrane already enforced that.)
			const wrapped = foreign ? props : prop_guard.wrap(props, entry);
			if (foreign_delegate) {
				// FOREIGN island: its module-level svelte state is not ours, so delegate the whole hydrate
				// to the entry's own `__og_hydrate` (and remember its unmounter). No NestedProvider, no
				// context capture — context deliberately does not cross a team boundary.
				// FOREIGN PAGE READS: the `$app/state` shim inside this island reads the SHELL's page store
				// (one singleton per document — the MFE's own seed never crosses the fragment boundary).
				// Mark the hydrate so that shim can warn (dev) when the island reads page.data/params/
				// route/form/error: its SSR HTML was rendered with the MFE's own load.
				set_foreign_hydrate({ origin: new URL(entry).origin, entry });
				const app = mod.__og_hydrate!(region, wrapped);
				out = handle(app, mod.__og_unmount ?? (() => {}), entry, false);
			} else {
				// Seed this island's context from any `<Provide>` above it in the DOM, so a child's plain
				// `getContext('key')` reads a (csr=false) layout's context across the island-root split.
				// Undefined when there is no provider above — the common case pays only a short DOM walk.
				const provided_ctx = capture_region_ids(region, () => slots.context?.(region));
				// A PERSIST island hydrates through LiveHost (same no-DOM render as NestedProvider) so
				// that when it relocates onto the next page its props can be pushed in reactively.
				const LiveHost = slots.live;
				if (region.hasAttribute('data-ogygia-keep') && LiveHost) {
					// Keep needs SPA navigation — a full-page load throws the DOM away, so there is nothing
					// to relocate. Warn (dev) when the router is off on this page.
					if (import.meta.env.DEV && !document.querySelector('meta[name="ogygia-router"]')) {
						console.warn(
							`[ogygia] island "${entry}" has keep:'${region.getAttribute('data-ogygia-keep')}' but the SPA router is off (ogygia({ router: false })) — keep relies on SPA navigation; a full-page load replaces the DOM, so the attribute is a no-op here.`
						);
					}
					const app = hydrate(LiveHost, {
						target: region,
						props: { component: Component, initialProps: wrapped },
						...(provided_ctx ? { context: provided_ctx } : {})
					});
					out = handle(app, unmount_app, entry, true);
				} else {
					const app = hydrate(NestedProvider, {
						target: region,
						props: { component: Component, props: wrapped },
						...(provided_ctx ? { context: provided_ctx } : {})
					});
					out = handle(app, unmount_app, entry, false);
				}
			}
		} finally {
			set_current_region(null);
			set_foreign_hydrate(null);
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
