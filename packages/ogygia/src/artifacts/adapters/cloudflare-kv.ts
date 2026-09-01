/**
 * artifacts — tier-2 store on Cloudflare Workers KV (BYO binding: `platform.env.MY_KV` under
 * adapter-cloudflare). KV has no sets and no scans — but it lists by key PREFIX, which our
 * keying law turns into everything needed: keys are `og:a:<pathname>` (subtree eviction = one
 * prefixed list) and the og.source reverse index rides SENTINEL keys `og:t:<tag>:<pathname>`
 * (tag eviction = one prefixed list, member encoded in the key itself).
 *
 * KNOWN CONTRACT DIFFERENCES (documented, not hidden): KV is eventually consistent (~60s edge
 * propagation — an invalidation may serve the old copy briefly at far POPs) and `expirationTtl`
 * has a 60-second floor (shorter policy TTLs are clamped up).
 *
 *   artifacts.configure({ store: cloudflareKv(platform.env.ARTIFACTS) });
 */
import type { ArtifactStore } from '../types.js';
import { normalize_prefix } from '../key.js';

const KEY_NS = 'og:a:';
const TAG_NS = 'og:t:';
const KV_MIN_TTL = 60;

/** The minimal Workers KV binding surface (KVNamespace, structurally). */
export interface KvNamespaceLike {
	get(key: string, type: 'text'): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export function cloudflareKv(kv: KvNamespaceLike): ArtifactStore {
	const list_prefix = async (prefix: string): Promise<string[]> => {
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await kv.list({ prefix, cursor });
			for (const k of page.keys) names.push(k.name);
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
		return names;
	};

	return {
		async get(key) {
			const raw = await kv.get(KEY_NS + key, 'text');
			if (!raw) return null;
			try {
				return JSON.parse(raw);
			} catch {
				return null;
			}
		},
		async put(key, entry, { ttl, tags }) {
			const expirationTtl = Math.max(KV_MIN_TTL, ttl);
			await kv.put(KEY_NS + key, JSON.stringify(entry), { expirationTtl });
			for (const tag of tags ?? []) {
				// Sentinel key: the member IS the suffix — one list() recovers the whole tag set.
				await kv.put(`${TAG_NS}${tag}:${key}`, '1', { expirationTtl });
			}
		},
		async evict(key) {
			await kv.delete(KEY_NS + key);
		},
		async evictWhere({ prefix }) {
			const p = normalize_prefix(prefix);
			for (const name of await list_prefix(KEY_NS + p + '/')) await kv.delete(name);
			await kv.delete(KEY_NS + p);
		},
		async evictByTag(tag) {
			const sentinel_prefix = `${TAG_NS}${tag}:`;
			const sentinels = await list_prefix(sentinel_prefix);
			const keys: string[] = [];
			for (const name of sentinels) {
				const key = name.slice(sentinel_prefix.length);
				keys.push(key);
				await kv.delete(KEY_NS + key);
				await kv.delete(name);
			}
			return keys;
		}
	};
}
