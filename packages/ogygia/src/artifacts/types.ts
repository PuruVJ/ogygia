/**
 * artifacts — pages as build artifacts (render-on-write). Shared contracts.
 *
 * The store holds THE RENDER: a full response (html + headers) or a permanent redirect,
 * keyed by URL pathname. Two tiny adapter contracts (see internal/notes/artifact.md):
 * every store impl passes ONE shared contract spec; every edge adapter speaks its CDN's
 * real purge API. Fan-out (allSettled across edges) lives in ogygia, never in adapters.
 *
 * Bulk eviction is PREFIX-shaped, not locale-shaped: the key is the URL, so any URL subtree
 * (`/fr/fr/` — a locale; `/docs/` — a section) evicts with one call. Locale was the bcms
 * motivating case, never the contract.
 */

/** A stored artifact: a finished page response, or a permanent redirect. */
export type ArtifactEntry =
	| {
			kind: 'page';
			html: string;
			/** Headers to replay on a hit (content-type + the verdict's cache-control + edge extras). */
			headers: Record<string, string>;
			/** Epoch ms at store time — TTL backstop math on the read side for stores without EX. */
			created: number;
	  }
	| {
			kind: 'redirect';
			status: 301 | 308;
			location: string;
			created: number;
	  };

/** Options `put` receives beyond the entry. */
export interface ArtifactPutOptions {
	/** TTL backstop in seconds (≤ 86400). Stores with native expiry (valkey EX) use it directly;
	 *  others compare against `entry.created` on read. */
	ttl: number;
	/** Source receipts recorded during the render (`s:<id>:<fp>` from `import.meta.og.source`
	 *  wrappers) — the REVERSE INDEX feeding `evictByTag`. Empty/omitted = no receipts. */
	tags?: string[];
}

/**
 * The store contract — four calls. Implementations MUST pass the shared contract spec
 * (test/artifacts-store-contract): tier-1 memory ships built-in; valkey rides `REDIS_URL` infra.
 * Keys are URL pathnames, so `evictWhere({ prefix })` is a key-prefix scan by construction.
 */
export interface ArtifactStore {
	get(key: string): Promise<ArtifactEntry | null>;
	put(key: string, entry: ArtifactEntry, options: ArtifactPutOptions): Promise<void>;
	evict(key: string): Promise<void>;
	evictWhere(filter: { prefix: string }): Promise<void>;
	/** The reverse index (og.source precision): evict every key whose receipts carry `tag` and
	 *  RETURN those keys — ogygia fans the returned URLs out to the edge adapters' `purgeUrl`.
	 *  Optional: a store without it degrades `invalidate(fn, args)` to a warning. */
	evictByTag?(tag: string): Promise<string[]>;
	/** Optional introspection for harnesses/devtools: number of live entries. */
	size?(): Promise<number>;
}

/** What `EdgeAdapter.headers` receives — enough to write the edge's storage instructions. */
export interface ArtifactMeta {
	/** Request pathname (the store key). */
	url: string;
	/** The policy TTL in seconds (the s-maxage the verdict grants). */
	ttl: number;
}

/**
 * The edge contract. `headers(meta)` returns extra response headers the CDN stores by —
 * Akamai stamps depth-capped PREFIX tags (`p:/fr`, `p:/fr/fr`, …) since Fast Purge can't take
 * an arbitrary prefix; CloudFront needs none (path wildcards are native). `purgeUrl`/`purgeWhere`
 * speak the CDN's REAL purge API. Adapters never fan out — ogygia calls every edge with
 * `allSettled` (one edge down ≠ publish down).
 */
export interface EdgeAdapter {
	/** Adapter name for logs/harness assertions ("akamai", "cloudfront"). */
	name: string;
	headers(meta: ArtifactMeta): Record<string, string>;
	purgeUrl(url: string): Promise<void>;
	purgeWhere(filter: { prefix: string }): Promise<void>;
}

/** `artifacts.configure({ … })` — live objects (clients/creds); hooks.server.ts only. */
export interface ArtifactsRuntimeConfig {
	store?: ArtifactStore;
	edge?: EdgeAdapter[];
}

/** The serializable policy baked by `ogygia({ artifacts })` into `virtual:ogygia/artifacts-config`. */
export interface ArtifactsPolicy {
	/** TTL backstop seconds, clamped to [1, 86400]. Default 86400 (24h) — nothing is stale forever. */
	ttl: number;
}
