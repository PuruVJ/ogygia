/**
 * artifacts — runtime registry: the configured store/edges, invalidation fan-out, single-flight.
 *
 * CONFIG SPLIT (the decide({source}) grammar): `ogygia({ artifacts })` in vite config is the
 * SWITCH + serializable policy (baked into `virtual:ogygia/artifacts-config`); LIVE objects
 * (store clients, purge creds) enter here via `artifacts.configure({ store, edge })` in
 * hooks.server.ts. No configure() → tier-1 memory store: the drop-in survives.
 */
import type {
	ArtifactEntry,
	ArtifactPutOptions,
	ArtifactStore,
	ArtifactsRuntimeConfig,
	EdgeAdapter
} from './types.js';
import { memory_store } from './memory-store.js';
import { normalize_prefix } from './key.js';
import { SOURCE_ID, SOURCE_KEY, fingerprint_args, source_tag } from './source-runtime.js';

let store: ArtifactStore | null = null;
let edges: EdgeAdapter[] = [];

function current_store(): ArtifactStore {
	return (store ??= memory_store());
}

/** `artifacts.configure({ store, edge })` — hooks.server.ts, before the first request. */
export function configure(config: ArtifactsRuntimeConfig): void {
	if (config.store) store = config.store;
	if (config.edge) edges = [...config.edge];
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

export async function artifact_get(key: string): Promise<ArtifactEntry | null> {
	try {
		return await current_store().get(key);
	} catch {
		return null;
	}
}

export async function artifact_put(
	key: string,
	entry: ArtifactEntry,
	options: ArtifactPutOptions
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

export type FlightOutcome = { stored: ArtifactEntry | null };
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
			console.warn(`[ogygia] artifacts.${label}: an edge purge failed —`, r.reason);
		}
	}
}

/** A function stamped by the `import.meta.og.source` macro (see source-runtime.ts). */
type SourceFn = ((...args: never[]) => unknown) & {
	[SOURCE_ID]?: string;
	[SOURCE_KEY]?: (...args: unknown[]) => string;
};

/**
 * Evict everywhere — two shapes:
 *   `invalidate('/fr/fr/solar/')`         exact URL (the v1 keying law: publish payloads carry it)
 *   `invalidate(loadContent, [args])`     og.source PRECISION: the reverse index answers which
 *                                         stored pages consumed `(source, args)` — those exact
 *                                         URLs are evicted at origin AND purged at every edge.
 */
export async function invalidate(
	target: string | SourceFn,
	args?: unknown[]
): Promise<void> {
	if (typeof target === 'string') {
		const jobs: Promise<unknown>[] = [current_store().evict(target)];
		for (const edge of edges) jobs.push(edge.purgeUrl(target));
		await settle_all('invalidate', jobs);
		return;
	}
	const id = target[SOURCE_ID];
	if (!id) {
		throw new Error(
			'[ogygia] artifacts.invalidate(fn, args): the function is not a declared source — ' +
				'wrap its definition: `export const fn = import.meta.og.source(async (…) => …)`.'
		);
	}
	const key_fn = target[SOURCE_KEY];
	const fp = key_fn ? key_fn(...(args ?? [])) : fingerprint_args(args ?? []);
	const tag = source_tag(id, fp);
	const evict_by_tag = current_store().evictByTag?.bind(current_store());
	if (!evict_by_tag) {
		console.warn(
			`[ogygia] artifacts.invalidate(fn): the configured store has no evictByTag — ` +
				`the og.source reverse index needs it (memory/valkey/upstash all provide it).`
		);
		return;
	}
	const keys = await evict_by_tag(tag);
	const jobs: Promise<unknown>[] = [];
	for (const key of keys) for (const edge of edges) jobs.push(edge.purgeUrl(key));
	await settle_all('invalidate(source)', jobs);
}

/** Bulk eviction by URL subtree — `{ prefix: '/fr/fr/' }` is a locale nuke, `{ prefix: '/docs' }`
 *  a section nuke. One origin scan + one purge per edge (Akamai: prefix tag; CloudFront: wildcard;
 *  Cloudflare: prefix purge). */
export async function invalidateWhere(filter: { prefix: string }): Promise<void> {
	const prefix = normalize_prefix(filter.prefix);
	const jobs: Promise<unknown>[] = [current_store().evictWhere({ prefix })];
	for (const edge of edges) jobs.push(edge.purgeWhere({ prefix }));
	await settle_all('invalidateWhere', jobs);
}

/** Action self-evict: a successful non-GET on a page URL evicts that URL (origin only — the
 *  edge copy follows via its s-maxage or the app's explicit invalidate; fire-and-forget). */
export function self_evict(pathname: string): void {
	void current_store()
		.evict(pathname)
		.catch(() => {});
}
