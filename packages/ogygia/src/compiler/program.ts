/**
 * The `Program` — the compiler's cross-file linker / island graph. It is the ONE long-lived,
 * stateful phase: a deterministic reduction of every file's `IslandDescriptor[]` into a whole-program
 * registry, deduped by content-hashed id. The blind, file-local front-end (parse ▸ analyze ▸ lower ▸
 * emit) mints descriptors; the `Program` accumulates them — never their sources — and the linker's
 * whole-program emitters read it.
 *
 * One instance per `Compiler` session, constructed in the plugin factory closure, never module-global
 * — so Kit's throwaway plugin instance is a different `Program` and can't leak into the real build.
 *
 * State has an owner: the registry Maps + the feature-mark bag live here with the behavior over them
 * (`register` / `unregister_host` / `note_runtime_mark`). Config-free by construction — it knows the
 * descriptors, never the resolved build context (that is `CompileCtx`'s job).
 */
import path from 'node:path';
import type { RuntimeMarks } from './link/runtime-entry.js';

/** Strip a `?query` off a module id (host vs component vs Vite watch paths). */
export const strip_id = (id: string) => (id ? id.split('?')[0] : id);

/** Canonical absolute host key (query-stripped, resolved) — the registry's cross-host dedupe key. */
export const host_key = (hostPath: string) => path.resolve(strip_id(hostPath));

/** One row in the virtual-module registry — an island's entry / wrapper / region-binding artifact.
 *  Loose by design: the three roles carry different legs (source vs ssrSource/clientSource). */
export interface RegistryEntry {
	source?: string;
	ssrSource?: string;
	clientSource?: string;
	hostPath?: string | null;
	id: string;
	server?: boolean;
	lakes?: string[];
	componentPath?: string | null;
	role?: 'entry' | 'wrapper' | 'region';
	portable?: boolean;
}

/** What a host's last transform indexed: the region ids + virtual paths it minted. */
interface HostIndexEntry {
	ids: Set<string>;
	vpaths: Set<string>;
}

/** One island a file's Lower phase minted — the `register`-relevant fields of a lowered descriptor.
 *  Loose (most fields optional) because the three legs — entry / wrapper / region binding — differ. */
export interface IslandDescriptor {
	id: string;
	kind?: 'hydrate' | 'defer' | 'lake';
	server?: boolean;
	fetchWhen?: string;
	strategy?: string;
	wakeAfter?: string;
	held?: boolean;
	lakes?: string[];
	keep?: string;
	portable?: boolean;
	wrapperPath?: string;
	wrapperSource?: string;
	bindingPath?: string;
	bindingSsrSource?: string;
	bindingClientSource?: string;
	hostPath?: string | null;
	componentPath?: string | null;
	virtualPath?: string;
	source?: string;
}

/** The relevant shape of a file's transform result the linker registers. */
export interface RegisterResult {
	islands?: IslandDescriptor[];
	hasIslandChildren?: boolean;
}

export class Program {
	/** keyed by virtual path → the island's registry row (entry / wrapper / region binding) */
	readonly registry = new Map<string, RegistryEntry>();
	/** Absolute module ids in an island's CLIENT dependency graph. `$app/*` resolves to shims
	 *  for these importers (virtual island module AND its transitive component imports). */
	readonly island_graph = new Set<string>();
	/** iid -> entry virtual path (hydrate / defer / swr-lake) */
	readonly by_id = new Map<string, string>();
	/** every region id -> kind (server manifest / emit) */
	readonly region_kinds = new Map<string, 'hydrate' | 'defer' | 'lake'>();
	/** host abs path → region ids + virtual paths discovered on last transform of that host */
	readonly host_index = new Map<string, HostIndexEntry>();
	/** region id → hosts still claiming it (cross-host dedupe: don't drop shared wrappers) */
	readonly id_hosts = new Map<string, Set<string>>();
	/** Client-leg: hydrate island ids whose deterministic chunk has been emitFile'd (dedup across the
	 *  buildStart prescan emit AND the transform-time emit that catches islands prescan can't see —
	 *  those declared inside LIBRARY components, where the host lives outside the app's `src`). */
	readonly emitted_island_chunks = new Set<string>();
	/** Absolute paths of app modules that define a transportable class (built during prescan). */
	readonly transportable_modules = new Set<string>();

	/** Build-time capability marks for the sticky runtime entry. Incomplete → kitchen-sink. */
	readonly runtime_marks: RuntimeMarks;

	/** The resolved feature set folded into the runtime chunk name (busts the immutable URL when the
	 *  app's feature set changes, not only when ogygia's source does). Filled by the driver's prescan;
	 *  empty until then (dev serves the package entry). Both build legs prescan the same source → same
	 *  hash → the server↔client filename handoff holds. */
	runtime_feature_hash = '';

	constructor(init: { forms: boolean; router: boolean }) {
		this.runtime_marks = {
			complete: false,
			forms: init.forms,
			// The wire runtime (transportable-class + portable-snippet prop revival, ~8kB) is the ONLY
			// consumer of `slots.wire` (read_region_props). It's off until the prescan proves the app
			// actually ships a transportable class or a portable snippet — so a plain-props app never
			// pays for a decoder it can't use. Turned on below via note_runtime_mark / the finalize check.
			wire: false,
			remoteSeeds: true,
			hydrate: [],
			defer: [],
			persistKeys: [],
			// Router is app-wide config now (not detected from a `<Router/>` usage): the feature ships
			// whenever `router` isn't `false`.
			router: init.router,
			live: false,
			lakes: false
		};
	}

	note_runtime_mark(patch: Partial<RuntimeMarks>) {
		const runtime_marks = this.runtime_marks;
		if (patch.hydrate) {
			runtime_marks.hydrate = [...new Set([...(runtime_marks.hydrate || []), ...patch.hydrate])];
		}
		if (patch.defer) {
			runtime_marks.defer = [...new Set([...(runtime_marks.defer || []), ...patch.defer])];
		}
		if (patch.persistKeys) {
			runtime_marks.persistKeys = [
				...new Set([...(runtime_marks.persistKeys || []), ...patch.persistKeys])
			];
		}
		if (patch.router) runtime_marks.router = true;
		if (patch.live) runtime_marks.live = true;
		if (patch.persist) runtime_marks.persist = true;
		if (patch.morph) runtime_marks.morph = true;
		if (patch.lakes) runtime_marks.lakes = true;
		if (patch.wire) runtime_marks.wire = true;
	}

	/** Drop this host's claims; shared region ids (cross-host dedupe) stay until unused. */
	unregister_host(hostPath: string) {
		const { registry, island_graph, by_id, region_kinds, host_index, id_hosts } = this;
		const key = host_key(hostPath);
		const prev = host_index.get(key);
		if (prev) {
			for (const id of prev.ids) {
				const holders = id_hosts.get(id);
				if (holders) {
					holders.delete(key);
					if (holders.size === 0) {
						id_hosts.delete(id);
						region_kinds.delete(id);
						by_id.delete(id);
					}
				} else {
					region_kinds.delete(id);
					by_id.delete(id);
				}
			}
			for (const vpath of prev.vpaths) {
				const entry = registry.get(vpath);
				if (entry) {
					const holders = id_hosts.get(entry.id);
					if (!holders || holders.size === 0) {
						registry.delete(vpath);
						island_graph.delete(vpath);
					}
				} else {
					registry.delete(vpath);
					island_graph.delete(vpath);
				}
			}
			host_index.delete(key);
		}
		// NB: do NOT clear the driver's transform_cache here. `register()` calls this on every leg AFTER
		// run_transform populated the cache, so clearing evicted the just-written entry (the cache
		// never hit → every host re-parsed 3× + an O(n) scan per call). The cache is content-keyed
		// (`hit.code === source`), so a changed source misses and recomputes on its own; a deleted
		// file's stale entry is harmless (never queried again). HMR correctness is preserved.
	}

	/** Replace this host's claims; shared ids keep one registry entry (path+strategy dedupe). */
	register(result: RegisterResult, hostId: string) {
		const { registry, island_graph, by_id, region_kinds, host_index, id_hosts } = this;
		this.unregister_host(hostId);
		const key = host_key(hostId);
		const idx: HostIndexEntry = { ids: new Set(), vpaths: new Set() };
		for (const isl of result.islands ?? []) {
			region_kinds.set(isl.id, isl.kind ?? (isl.server ? 'defer' : 'hydrate'));
			idx.ids.add(isl.id);
			const kind = isl.kind ?? (isl.server ? 'defer' : 'hydrate');
			// Record the ACTUAL wake schedule (so `interaction` is detected) + the deferred fetch
			// timing (so streaming is only pulled for `render: 'deferred'` load holes).
			if (kind === 'defer') this.note_runtime_mark({ defer: [isl.fetchWhen || 'load'] });
			if (kind === 'hydrate') this.note_runtime_mark({ hydrate: [isl.strategy || 'load'] });
			if (isl.wakeAfter) this.note_runtime_mark({ hydrate: [isl.wakeAfter] });
			if (kind === 'lake') this.note_runtime_mark({ lakes: true, hydrate: ['none'] });
			// live + client-morph are needed by HELD regions (region() / region:'raw' / live content),
			// which stream and re-render on the client — NOT by a plain `wake`-marked placed island,
			// which merely hydrates once. Every wake import now has a `bindingPath` (attach-to-binding
			// unification), so gating on that over-shipped live+morph to minimal apps; gate on `held`.
			if (isl.held) this.note_runtime_mark({ live: true, morph: true });
			if (isl.lakes?.length) this.note_runtime_mark({ lakes: true });
			if (isl.keep) this.note_runtime_mark({ persist: true, persistKeys: [isl.keep] });
			// A portable-snippet synth entry crosses a live snippet into an island — it is revived on the
			// client through the wire codec, so this app needs the wire runtime.
			if (isl.portable) this.note_runtime_mark({ wire: true });
			// Likewise a hydrate island with real HOST CHILDREN: they cross as an OgygiaS slot
			// pointer the client must revive (adapters regression: a minimal app with children got a
			// usage-gated runtime without the revivers → "Unknown type OgygiaS" at hydrate).
			if (result.hasIslandChildren) this.note_runtime_mark({ wire: true });
			let holders = id_hosts.get(isl.id);
			if (!holders) {
				holders = new Set();
				id_hosts.set(isl.id, holders);
			}
			holders.add(key);

			if (isl.wrapperPath && isl.wrapperSource) {
				registry.set(isl.wrapperPath, {
					source: isl.wrapperSource,
					hostPath: isl.hostPath,
					id: isl.id,
					server: false,
					lakes: isl.lakes ?? [],
					componentPath: isl.componentPath ?? null,
					role: 'wrapper'
				});
				idx.vpaths.add(isl.wrapperPath);
				island_graph.add(isl.wrapperPath);
			}
			// Region binding: the host imports this JS module; its source is leg-split at load()
			// (SSR carries the signer, client is metadata-only). Not a svelte wrapper.
			if (isl.bindingPath && isl.bindingSsrSource) {
				registry.set(isl.bindingPath, {
					ssrSource: isl.bindingSsrSource,
					clientSource: isl.bindingClientSource ?? isl.bindingSsrSource,
					hostPath: isl.hostPath,
					id: isl.id,
					server: false,
					lakes: [],
					componentPath: isl.componentPath ?? null,
					role: 'region'
				});
				idx.vpaths.add(isl.bindingPath);
				island_graph.add(isl.bindingPath);
			}
			if (isl.virtualPath && isl.source) {
				registry.set(isl.virtualPath, {
					source: isl.source,
					hostPath: isl.hostPath,
					id: isl.id,
					server: !!isl.server,
					lakes: [],
					componentPath: isl.componentPath ?? null,
					role: 'entry',
					// A portable-snippet synth entry is AUTHORED markup (a slice of user source) — the
					// transform hook re-processes it (nested island marks, nested snippets), unlike glue.
					portable: isl.portable === true
				});
				by_id.set(isl.id, isl.virtualPath);
				idx.vpaths.add(isl.virtualPath);
				island_graph.add(isl.virtualPath);
			} else if (isl.virtualPath) {
				by_id.set(isl.id, isl.virtualPath);
			}
			if (isl.componentPath) island_graph.add(isl.componentPath);
		}
		host_index.set(key, idx);
	}
}
