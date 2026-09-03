/**
 * freeze — Cloudflare edge adapter: zone purge with a bearer API token.
 *
 * `purgeUrl` = purge by files (every plan); `purgeWhere({ prefix })` = purge by prefixes
 * (`<host><prefix>` — Cloudflare's native URL-subtree purge; Enterprise). `headers(meta)` stamps
 * the same depth-capped prefix tags as Akamai under `cache-tag` (Enterprise honors them; other
 * plans ignore the header harmlessly) plus the verdict's `s-maxage`.
 *
 * `baseUrl` override points the SAME adapter at a harness emulator — the real request/auth
 * shape is what gets exercised.
 */
import type { FreezeMeta, EdgeAdapter } from '../types.js';
import { prefix_tags, normalize_prefix } from '../key.js';

// ── regexes
const TRAILING_SLASHES_RE = /\/+$/;
const HTTP_SCHEME_RE = /^https?:\/\//;

export interface CloudflareConfig {
	zoneId: string;
	/** An API token with `Zone.Cache Purge` permission (`authorization: Bearer <token>`). */
	apiToken: string;
	/** The public site origin purged URLs are absolute against, e.g. `https://www.se.com`. */
	site: string;
	/** Harness override: send API calls here instead of `https://api.cloudflare.com`. */
	baseUrl?: string;
	/** The s-maxage this edge is granted (defaults to the policy TTL in `headers(meta)`). */
	maxAge?: number;
}

export function cloudflare(config: CloudflareConfig): EdgeAdapter {
	const api_base = (config.baseUrl ?? 'https://api.cloudflare.com').replace(
		TRAILING_SLASHES_RE,
		''
	);
	const site = config.site.replace(TRAILING_SLASHES_RE, '');
	const site_host = site.replace(HTTP_SCHEME_RE, '');

	const purge = async (body: Record<string, unknown>): Promise<void> => {
		const res = await fetch(`${api_base}/client/v4/zones/${config.zoneId}/purge_cache`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			throw new Error(
				`[ogygia] cloudflare purge failed: ${res.status} ${await res.text().catch(() => '')}`
			);
		}
	};

	return {
		name: 'cloudflare',
		headers(meta: FreezeMeta) {
			const tags = prefix_tags(meta.url).map((p) => `p:${p}`);
			const out: Record<string, string> = {};
			if (tags.length) out['cache-tag'] = tags.join(',');
			const max_age = config.maxAge ?? meta.ttl;
			if (max_age > 0) out['cache-control'] = `public, s-maxage=${max_age}`;
			return out;
		},
		async purgeUrl(url) {
			await purge({ files: [site + url] });
		},
		async purgeWhere({ prefix }) {
			await purge({ prefixes: [site_host + normalize_prefix(prefix)] });
		}
	};
}
