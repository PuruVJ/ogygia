/**
 * REMOTE SEED ONLY WHEN REACHABLE — the handle's per-remote decision when it builds the
 * `application/ogygia-remote` seed: does any region rendered on this page have client code that
 * can call this remote? The seed exists so a hydrating island that re-runs the same query resolves
 * it from the document (zero-flash, no re-fetch). A remote no island on the page imports — a lake
 * or a page script awaiting a query for its own server render — has no such reader, and its
 * result is pure download weight (a CMS footer entry: 12.5 KB, measured).
 *
 * `wanted` is the union of every rendered region's `islandRemotes(entry)` (Region.svelte →
 * page-seed-registry → the request bag): Kit id-hashes, the prefix of a remote's `internals.id`
 * (`${hash}/${name}`). `null` = some region answered fail-open ("may call anything": a promise `of`,
 * an entry the build handoff does not know, dev) → every remote seeds, exactly as before the gate.
 * Pure, so it is unit-tested on its own.
 */
export function remote_seed_wanted(remote_id: string, wanted: ReadonlySet<string> | null): boolean {
	if (wanted === null) return true;
	const slash = remote_id.indexOf('/');
	// An id without the `${hash}/` prefix is not a Kit remote id we know how to name — keep it
	// (fail-open on the unknown, never drop what a reader might need).
	if (slash === -1) return true;
	return wanted.has(remote_id.slice(0, slash));
}

/** Kit's `RequestState.remote.implicit` entry: the remote's internals + its per-payload results. */
export interface ImplicitRemote {
	id?: string;
	type: string;
}
export type ImplicitMap = Iterable<[ImplicitRemote, Record<string, () => unknown>]>;
export type SeedBuckets = Record<'q' | 'p' | 'l' | 'f', Record<string, { v: unknown }>>;

/**
 * Mirror Kit's OWN seed bucketing (server/remote.js) over the side-channel — Kit only serializes
 * remote data inline when csr===true, so on csr=false pages the handle does it here. Buckets every
 * implicit remote by type: q(query) / p(prerender) / l(query.live) / f(form). Seeding PRERENDER
 * remotes (not only queries) is the fix for the async-island FOUC: a prerender remote awaited inside
 * an island otherwise re-fetches on hydrate, so the component re-renders and Svelte RE-MOUNTS the
 * subtree — a frame of unstyled DOM. With the seed in `prerender_responses`, the client resolves it
 * synchronously and never re-fetches. Keys use `create_remote_key`, exactly like Kit's client.
 *
 * Skips, in order: a PRIVATE remote (no id — must never be serialized), a remote NO REGION'S
 * CLIENT CAN CALL (`wanted`, above), an ERRORED or still-PENDING result (the client fetches it
 * itself; an entry without `v` would hydrate as `undefined`), and a value carrying a BAKED region
 * (`skip_value`: SSR HTML in the ticket — a page body from a `doc`-style remote is a page-sized
 * RENDER the page already rendered; seeding it ships the body twice, ~130 KB/page measured).
 *
 * Pure over what it is handed (the implicit map, the request's memo of results, the two
 * predicates); the handle serializes what comes back. Unit-tested across every permutation.
 */
export async function collect_remote_seed(
	implicit: ImplicitMap,
	wanted: ReadonlySet<string> | null,
	opts: {
		/** Kit's per-request memo of results already awaited (`state.remote.data`); a miss re-invokes. */
		memo?: (internals: ImplicitRemote) => Record<string, unknown> | undefined;
		/** A resolved value that must NOT seed (a baked region). */
		skip_value?: (v: unknown) => boolean;
		/** Kit's `create_remote_key(id, payload)`. */
		key: (id: string, payload: string) => string;
	}
): Promise<SeedBuckets> {
	const data: SeedBuckets = { q: {}, p: {}, l: {}, f: {} };
	for (const [internals, record] of implicit) {
		if (!internals.id) continue;
		if (!remote_seed_wanted(internals.id, wanted)) continue;
		const type = internals.type;
		const bucket = type === 'query_live' ? 'l' : (type[0] as 'q' | 'p' | 'l' | 'f');
		if (bucket !== 'q' && bucket !== 'p' && bucket !== 'l' && bucket !== 'f') continue;
		for (const payload in record) {
			// form outputs are keyed by the client-side action id directly (Kit parity).
			const remote_key = type === 'form' ? payload : opts.key(internals.id, payload);
			const promise = opts.memo?.(internals)?.[payload] ?? record[payload]();
			let resolved = true;
			await Promise.race([
				Promise.resolve(promise).then(
					(v) => {
						if (resolved && !opts.skip_value?.(v)) data[bucket][remote_key] = { v };
					},
					() => {
						/* errored/pending remotes are omitted → the client fetches them itself */
					}
				),
				Promise.resolve().then(() => {
					resolved = false;
				})
			]);
		}
	}
	return data;
}
