/**
 * artifacts — Akamai edge adapter: Fast Purge v3 (url + tag) with real EdgeGrid request signing.
 *
 * `headers(meta)` stamps the depth-capped PREFIX tags (`edge-cache-tag: p:/fr, p:/fr/fr, …`) the
 * property stores by; `purgeWhere({ prefix })` purges the matching tag — Fast Purge has no
 * arbitrary-prefix purge, tags ARE the prefix mechanism. `purgeUrl` purges by absolute URL.
 *
 * `baseUrl` override points the SAME adapter at the harness's edge emulator — e2e exercises this
 * exact signing/requesting code, not a mock of it.
 */
import { createHmac, createHash, randomUUID } from 'node:crypto';
import type { ArtifactMeta, EdgeAdapter } from '../types.js';
import { prefix_tags, normalize_prefix } from '../key.js';

export interface AkamaiConfig {
	/** The EdgeGrid host, e.g. `akab-xxxx.purge.akamaiapis.net`. */
	host: string;
	clientToken: string;
	clientSecret: string;
	accessToken: string;
	/** The public site origin purged URLs are absolute against, e.g. `https://www.se.com`. */
	site: string;
	/** Fast Purge network (default `production`). */
	network?: 'production' | 'staging';
	/** Harness override: send API calls here instead of `https://<host>` (the edge emulator). */
	baseUrl?: string;
	/** The s-maxage this edge is granted (defaults to the policy TTL in `headers(meta)`). */
	maxAge?: number;
}

/** EdgeGrid timestamp: `yyyyMMddTHH:mm:ss+0000`. */
function edgegrid_timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0000`
	);
}

const b64_hmac = (key: string | Buffer, data: string) =>
	createHmac('sha256', key).update(data).digest('base64');
const b64_sha = (data: string) => createHash('sha256').update(data).digest('base64');

export function akamai(config: AkamaiConfig): EdgeAdapter {
	const network = config.network ?? 'production';
	const api_base = (config.baseUrl ?? `https://${config.host}`).replace(/\/+$/, '');

	/** Real EdgeGrid signing (EG1-HMAC-SHA256) over the canonical request. */
	const signed_post = async (path: string, body: unknown): Promise<void> => {
		const payload = JSON.stringify(body);
		const timestamp = edgegrid_timestamp();
		const nonce = randomUUID();
		const auth_prefix =
			`EG1-HMAC-SHA256 client_token=${config.clientToken};` +
			`access_token=${config.accessToken};timestamp=${timestamp};nonce=${nonce};`;
		const url = new URL(api_base + path);
		// Canonical data: METHOD \t scheme \t host \t path+query \t canonical-headers \t content-hash \t auth
		const data_to_sign = [
			'POST',
			url.protocol.replace(':', ''),
			config.host,
			url.pathname + url.search,
			'', // no signed headers
			b64_sha(payload),
			auth_prefix
		].join('\t');
		const signing_key = b64_hmac(config.clientSecret, timestamp);
		const signature = b64_hmac(signing_key, data_to_sign);
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `${auth_prefix}signature=${signature}`
			},
			body: payload
		});
		if (!res.ok) {
			throw new Error(`[ogygia] akamai purge failed: ${res.status} ${await res.text().catch(() => '')}`);
		}
	};

	return {
		name: 'akamai',
		headers(meta: ArtifactMeta) {
			const tags = prefix_tags(meta.url).map((p) => `p:${p}`);
			const out: Record<string, string> = {};
			if (tags.length) out['edge-cache-tag'] = tags.join(', ');
			const max_age = config.maxAge ?? meta.ttl;
			if (max_age > 0) out['cache-control'] = `public, s-maxage=${max_age}`;
			return out;
		},
		async purgeUrl(url) {
			await signed_post(`/ccu/v3/invalidate/url/${network}`, {
				objects: [config.site.replace(/\/+$/, '') + url]
			});
		},
		async purgeWhere({ prefix }) {
			await signed_post(`/ccu/v3/invalidate/tag/${network}`, {
				objects: [`p:${normalize_prefix(prefix)}`]
			});
		}
	};
}
