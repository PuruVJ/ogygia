/**
 * freeze — tier-2 store on Upstash Redis (REST). Serverless-native: no client library, no
 * connection — every command is one signed HTTPS call, which is exactly what edge/lambda origins
 * want. Same key scheme as the valkey adapter (`og:a:<pathname>`, `og:t:<tag>` sets).
 *
 *   freeze.configure({ store: upstash({ url: env.UPSTASH_REDIS_REST_URL,
 *                                          token: env.UPSTASH_REDIS_REST_TOKEN }) });
 */
import type { FreezeStore } from '../types.js';
import { normalize_prefix } from '../key.js';

// ── regexes
const GLOB_ACTIVE_G = /[*?[\]\\]/g;
const TRAILING_SLASHES_RE = /\/+$/;

const KEY_NS = 'og:a:';
const TAG_NS = 'og:t:';
const SCAN_COUNT = 250;

export interface UpstashConfig {
	/** The REST endpoint, e.g. `https://usw1-xxxx.upstash.io`. */
	url: string;
	token: string;
}

/** Escape glob-active characters so a literal pathname can ride a SCAN MATCH pattern. */
function glob_escape(value: string): string {
	return value.replace(GLOB_ACTIVE_G, (c) => '\\' + c);
}

export function upstash(config: UpstashConfig): FreezeStore {
	const base = config.url.replace(TRAILING_SLASHES_RE, '');

	/** One command, Upstash REST shape: POST the command as a JSON array → `{ result }`. */
	const command = async <T>(parts: (string | number)[]): Promise<T> => {
		const res = await fetch(base, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify(parts.map(String))
		});
		if (!res.ok) {
			throw new Error(
				`[ogygia] upstash command failed: ${res.status} ${await res.text().catch(() => '')}`
			);
		}
		return ((await res.json()) as { result: T }).result;
	};

	return {
		async get(key) {
			const raw = await command<string | null>(['GET', KEY_NS + key]);
			if (!raw) return null;
			try {
				return JSON.parse(raw);
			} catch {
				return null;
			}
		},
		async put(key, entry, { ttl, tags }) {
			await command(['SET', KEY_NS + key, JSON.stringify(entry), 'EX', ttl]);
			for (const tag of tags ?? []) {
				await command(['SADD', TAG_NS + tag, key]);
				await command(['EXPIRE', TAG_NS + tag, ttl]);
			}
		},
		async evict(key) {
			await command(['DEL', KEY_NS + key]);
		},
		async evictWhere({ prefix }) {
			const p = normalize_prefix(prefix);
			const pattern = glob_escape(KEY_NS + p + '/') + '*';
			let cursor = '0';
			do {
				const reply = await command<[string, string[]]>([
					'SCAN',
					cursor,
					'MATCH',
					pattern,
					'COUNT',
					SCAN_COUNT
				]);
				cursor = String(reply[0]);
				if (reply[1]?.length) await command(['DEL', ...reply[1]]);
			} while (cursor !== '0');
			await command(['DEL', KEY_NS + p]);
		},
		async evictByTag(tag) {
			const members = await command<string[]>(['SMEMBERS', TAG_NS + tag]);
			if (members.length) await command(['DEL', ...members.map((m) => KEY_NS + m)]);
			await command(['DEL', TAG_NS + tag]);
			return members;
		}
	};
}
