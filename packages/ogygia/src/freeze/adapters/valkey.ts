/**
 * freeze — tier-2 store on Valkey/Redis. BYO client (ioredis or node-redis v4 both fit the
 * minimal shape below — ogygia takes no redis dependency). Keys are `og:a:<pathname>`, value =
 * JSON entry, EX = the TTL backstop. Prefix eviction is a native cursor SCAN over
 * `og:a:<prefix>*` — the key IS the URL, so no index exists to drift. The og.source reverse
 * index is a per-tag SET (`og:t:<tag>` of plain pathnames, EX-refreshed on every put; members
 * of expired entries are harmless — deleting a gone key is a no-op).
 */
import type { FreezeStore } from '../types.js';
import { normalize_prefix } from '../key.js';

// ── regexes
const GLOB_ACTIVE_G = /[*?[\]\\]/g;

const KEY_NS = 'og:a:';
const TAG_NS = 'og:t:';
const SCAN_COUNT = 250;

/** The minimal client surface — ioredis (lowercase) and node-redis v4 (camelCase) both satisfy
 *  it structurally; the camelCase variants are probed at call time. */
export interface ValkeyLike {
	get(key: string): Promise<string | null>;
	/** ioredis-style positional EX; node-redis v4 accepts (key, value, { EX }) — both supported. */
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	del(...keys: string[]): Promise<unknown>;
	scan(cursor: string | number, ...args: unknown[]): Promise<unknown>;
	sadd?(key: string, ...members: string[]): Promise<unknown>;
	sAdd?(key: string, members: string | string[]): Promise<unknown>;
	smembers?(key: string): Promise<string[]>;
	sMembers?(key: string): Promise<string[]>;
	expire?(key: string, seconds: number): Promise<unknown>;
}

/** Both client families' scan shapes → one { cursor, keys }. */
function read_scan_reply(reply: unknown): { cursor: string; keys: string[] } {
	if (Array.isArray(reply)) {
		return { cursor: String(reply[0]), keys: (reply[1] as string[]) ?? [] };
	}
	const obj = reply as { cursor: string | number; keys: string[] };
	return { cursor: String(obj.cursor), keys: obj.keys ?? [] };
}

/** Escape glob-active characters so a literal pathname can ride a SCAN MATCH pattern. */
function glob_escape(value: string): string {
	return value.replace(GLOB_ACTIVE_G, (c) => '\\' + c);
}

export function valkey(client: ValkeyLike): FreezeStore {
	const set_with_ttl = async (key: string, value: string, ttl: number) => {
		try {
			// ioredis positional form first — node-redis v4 throws on it, then takes the options bag.
			await client.set(key, value, 'EX', ttl);
		} catch {
			await client.set(key, value, { EX: ttl } as unknown as string);
		}
	};

	const sadd = async (key: string, member: string) => {
		if (client.sadd) await client.sadd(key, member);
		else if (client.sAdd) await client.sAdd(key, member);
		else throw new Error('[ogygia] valkey client has no sadd/sAdd — og.source tags need it');
	};
	const smembers = async (key: string): Promise<string[]> => {
		if (client.smembers) return client.smembers(key);
		if (client.sMembers) return client.sMembers(key);
		throw new Error('[ogygia] valkey client has no smembers/sMembers — og.source tags need it');
	};

	const scan_prefix = async (prefix: string, on_keys: (keys: string[]) => Promise<void>) => {
		const pattern = glob_escape(KEY_NS + prefix) + '*';
		let cursor = '0';
		do {
			const reply = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
			const page = read_scan_reply(reply);
			cursor = page.cursor;
			if (page.keys.length) await on_keys(page.keys);
		} while (cursor !== '0');
	};

	return {
		async get(key) {
			const raw = await client.get(KEY_NS + key);
			if (!raw) return null;
			try {
				return JSON.parse(raw);
			} catch {
				return null;
			}
		},
		async put(key, entry, { ttl, tags }) {
			await set_with_ttl(KEY_NS + key, JSON.stringify(entry), ttl);
			for (const tag of tags ?? []) {
				await sadd(TAG_NS + tag, key);
				await client.expire?.(TAG_NS + tag, ttl);
			}
		},
		async evict(key) {
			await client.del(KEY_NS + key);
		},
		async evictWhere({ prefix }) {
			const p = normalize_prefix(prefix);
			// `/fr/fr` must match itself + its subtree, never `/fr/fright`: two exact patterns.
			await scan_prefix(p + '/', async (keys) => void (await client.del(...keys)));
			await client.del(KEY_NS + p);
		},
		async evictByTag(tag) {
			const members = await smembers(TAG_NS + tag);
			if (members.length) await client.del(...members.map((m) => KEY_NS + m));
			await client.del(TAG_NS + tag);
			return members;
		}
	};
}
