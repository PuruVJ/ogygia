/**
 * freeze — runtime registry: the configured store/edges, invalidation fan-out, single-flight.
 *
 * CONFIG SPLIT (the decide({source}) grammar): `freeze({ ttl, default })` in the vite config's
 * plugins is the SWITCH + serializable policy (handed to the server half as its options); LIVE
 * objects (store clients, purge creds) enter here via `freeze.configure({ store, edge })` in
 * hooks.server.ts. No configure() → tier-1 memory store: the drop-in survives.
 */
import type {
	FreezeEntry,
	FreezePutOptions,
	FreezeStore,
	FreezeRuntimeConfig,
	EdgeAdapter
} from './types.ts';
import { memory_store } from './memory-store.ts';
import { normalize_prefix } from './key.ts';
import type { DevtoolsEventInput } from 'ogygia/plugin';
import { sourceTag } from 'ogygia/plugin/utils';
import { freeze_app } from './app.ts';

/** A server event into the current request's devtools stream (a no-op unless devtools is on). */
function record(event: DevtoolsEventInput): void {
	freeze_app()?.devtools(event);
}

let store: FreezeStore | null = null;
let edges: EdgeAdapter[] = [];

export function current_store(): FreezeStore {
	return (store ??= memory_store());
}

let warned_replica_blindspot = false;

/** `freeze.configure({ store, edge })` — hooks.server.ts, before the first request. */
export function configure(config: FreezeRuntimeConfig): void {
	if (config.store) store = config.store;
	if (config.edge) edges = [...config.edge];
	// Edges without a SHARED store: each replica keeps its own memory LRU, so an invalidation
	// evicts THIS instance + purges the CDN, while sibling replicas keep serving their stale
	// copy to the CDN's refills. Say it once — multi-instance deploys want valkey/upstash/KV.
	if (edges.length && !config.store && !store && !warned_replica_blindspot) {
		warned_replica_blindspot = true;
		console.warn(
			'[ogygia] freeze: edge adapters are configured but the store is the per-instance ' +
				'memory default — invalidations cannot reach other replicas. Use a shared store ' +
				'(valkey / upstash / cloudflareKv) in multi-instance deploys.'
		);
	}
}

// ── cross-app thaw (federation) ──────────────────────────────────────────────────────────────
// Every invalidation that can be expressed as TAGS is announced through the shared `invalidated`
// hook; a `federate()` implements it and tells the peers that baked this app's fragments (see
// internal/notes/federation.md §4). Fire-and-forget: a peer that is down never fails a publish.
function notify_thaw(tags: string[] | 'all'): void {
	void freeze_app()?.notify.invalidated(tags);
}

/** Evict every stored page carrying ANY of `tags` (origin + every edge). The receiving half of a
 *  thaw notice; also what `invalidate(fn, args)` does for one receipt tag. */
export async function invalidate_tags(tags: readonly string[]): Promise<string[]> {
	const store = current_store();
	const evict_by_tag = store.evictByTag?.bind(store);
	if (!evict_by_tag) {
		console.warn(
			'[ogygia] freeze: the configured store has no evictByTag — tag invalidation needs it ' +
				'(memory/valkey/upstash/cloudflareKv all provide it).'
		);
		return [];
	}
	const keys = new Set<string>();
	for (const tag of tags) for (const key of await evict_by_tag(tag)) keys.add(key);
	const jobs: Promise<unknown>[] = [];
	for (const key of keys) for (const edge of edges) jobs.push(edge.purgeUrl(key));
	await settle_all('invalidate(tags)', jobs);
	return [...keys];
}

export function current_edges(): readonly EdgeAdapter[] {
	return edges;
}

/** Harness/test escape hatch: drop back to defaults (memory store, no edges). */
export function reset_for_tests(): void {
	store = null;
	edges = [];
}

// ── read/write (hooks-facing; store failures NEVER fail a request) ─────────────────────────────

export async function freeze_get(key: string): Promise<FreezeEntry | null> {
	try {
		return await current_store().get(key);
	} catch {
		return null;
	}
}

export async function freeze_put(
	key: string,
	entry: FreezeEntry,
	options: FreezePutOptions
): Promise<void> {
	try {
		await current_store().put(key, entry, options);
	} catch {
		/* a broken store must never 500 a render */
	}
}

// ── single-flight ──────────────────────────────────────────────────────────────────────────────
// The stampede law (the harness DEFINES it): N concurrent cold requests for an ELIGIBLE page =
// ONE render. The first request registers its flight; joiners await the outcome. `stored: null`
// means the flight rendered but the page proved ineligible — joiners then render themselves
// (correct: ineligible pages are per-request by definition).

export type FlightOutcome = { stored: FreezeEntry | null };
const inflight = new Map<string, Promise<FlightOutcome>>();

export function join_flight(key: string): Promise<FlightOutcome> | null {
	return inflight.get(key) ?? null;
}

export function begin_flight(key: string): (outcome: FlightOutcome) => void {
	let settle!: (outcome: FlightOutcome) => void;
	const flight = new Promise<FlightOutcome>((res) => {
		settle = res;
	});
	inflight.set(key, flight);
	return (outcome) => {
		inflight.delete(key);
		settle(outcome);
	};
}

// ── invalidation fan-out ───────────────────────────────────────────────────────────────────────
// Fan-out lives HERE, not in adapters: store evict + allSettled purge across every edge.
// One edge being down never fails the publish — failures surface as warnings, not throws.

async function settle_all(label: string, jobs: Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(jobs);
	for (const r of results) {
		if (r.status === 'rejected') {
			console.warn(`[ogygia] freeze.${label}: an edge purge failed —`, r.reason);
		}
	}
}

/** A function stamped by the `import.meta.og.source` macro (core's data sources). */
type SourceFn = (...args: never[]) => unknown;

/**
 * Evict everywhere — two shapes:
 *   `invalidate('/fr/fr/solar/')`         exact URL (the v1 keying law: publish payloads carry it)
 *   `invalidate(loadContent, [args])`     og.source PRECISION: the reverse index answers which
 *                                         stored pages consumed `(source, args)` — those exact
 *                                         URLs are evicted at origin AND purged at every edge.
 */
export async function invalidate(target: string | SourceFn, args?: unknown[]): Promise<void> {
	if (typeof target === 'string') {
		record({ domain: 'server', name: 'server.freeze', op: 'invalidate', url: target });
		const jobs: Promise<unknown>[] = [current_store().evict(target)];
		for (const edge of edges) jobs.push(edge.purgeUrl(target));
		await settle_all('invalidate', jobs);
		// peers file the pages that baked THIS route under `p:<me>:<path>` — tell them
		notify_thaw([`p:${target}`]);
		return;
	}
	const tag = sourceTag(target, args ?? []);
	if (!tag) {
		throw new Error(
			'[ogygia] freeze.invalidate(fn, args): the function is not a declared source — ' +
				'wrap its definition: `export const fn = import.meta.og.source(async (…) => …)`.'
		);
	}
	await invalidate_tags([tag]);
	// peers file the pages that baked a fragment which read this source under `r:<me>:<tag>`
	notify_thaw([tag]);
}

/** Bulk eviction by URL subtree — `{ prefix: '/fr/fr/' }` is a locale nuke, `{ prefix: '/docs' }`
 *  a section nuke. One origin scan + one purge per edge (Akamai: prefix tag; CloudFront: wildcard;
 *  Cloudflare: prefix purge). */
export async function invalidateWhere(filter: { prefix: string }): Promise<void> {
	const prefix = normalize_prefix(filter.prefix);
	record({ domain: 'server', name: 'server.freeze', op: 'invalidate-where', url: prefix });
	const jobs: Promise<unknown>[] = [current_store().evictWhere({ prefix })];
	for (const edge of edges) jobs.push(edge.purgeWhere({ prefix }));
	await settle_all('invalidateWhere', jobs);
	// a subtree nuke has no per-page receipts to name — peers thaw EVERYTHING they baked from
	// this app (the safe over-approximation; `{ prefix: '/' }` is also the manual deploy thaw)
	notify_thaw('all');
}

/** Action self-evict: a successful non-GET on a page URL evicts that URL (origin only — the
 *  edge copy follows via its s-maxage or the app's explicit invalidate; fire-and-forget). */
export function self_evict(pathname: string): void {
	record({ domain: 'server', name: 'server.freeze', op: 'self-evict', url: pathname });
	void current_store()
		.evict(pathname)
		.catch(() => {});
}
