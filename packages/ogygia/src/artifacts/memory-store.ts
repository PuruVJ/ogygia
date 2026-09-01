/**
 * artifacts — tier-1 store: in-process bounded LRU with TTL backstop + the tag reverse index
 * (og.source receipts). The zero-infra default (`ogygia({ artifacts: true })` with no
 * `configure()`): single-instance adapter-node. Replicas / serverless want tier 2 (valkey /
 * upstash) — a per-instance LRU there means per-instance misses AND invalidation blind spots.
 */
import type { ArtifactEntry, ArtifactPutOptions, ArtifactStore } from './types.js';
import { normalize_prefix } from './key.js';

const DEFAULT_MAX_ENTRIES = 1000;

export function memory_store(max_entries = DEFAULT_MAX_ENTRIES): ArtifactStore {
	// Map iteration order = insertion order → delete+set on touch makes it an LRU.
	const entries = new Map<string, { entry: ArtifactEntry; expires: number }>();
	// tag → keys (og.source receipts). Dead keys are tolerated (evicted entries leave their tag
	// refs behind; a later evictByTag deleting a gone key is a no-op) — no sweep bookkeeping.
	const tag_index = new Map<string, Set<string>>();

	const alive = (key: string) => {
		const rec = entries.get(key);
		if (!rec) return null;
		if (Date.now() >= rec.expires) {
			entries.delete(key);
			return null;
		}
		return rec;
	};

	return {
		async get(key) {
			const rec = alive(key);
			if (!rec) return null;
			// LRU touch
			entries.delete(key);
			entries.set(key, rec);
			return rec.entry;
		},
		async put(key, entry, options: ArtifactPutOptions) {
			if (entries.size >= max_entries && !entries.has(key)) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			entries.set(key, { entry, expires: Date.now() + options.ttl * 1000 });
			for (const tag of options.tags ?? []) {
				let set = tag_index.get(tag);
				if (!set) tag_index.set(tag, (set = new Set()));
				set.add(key);
			}
		},
		async evict(key) {
			entries.delete(key);
		},
		async evictWhere({ prefix }) {
			// Keys ARE pathnames — a subtree eviction is a startsWith scan. `/fr/fr` matches
			// `/fr/fr` itself and everything under `/fr/fr/`, never `/fr/fright`.
			const p = normalize_prefix(prefix);
			for (const key of [...entries.keys()]) {
				if (key === p || key.startsWith(p.endsWith('/') ? p : p + '/')) entries.delete(key);
			}
		},
		async evictByTag(tag) {
			const set = tag_index.get(tag);
			if (!set) return [];
			tag_index.delete(tag);
			const evicted: string[] = [];
			for (const key of set) {
				if (entries.delete(key)) evicted.push(key);
			}
			return evicted;
		},
		async size() {
			// Sweep expired so harness counts reflect live entries only.
			for (const key of [...entries.keys()]) alive(key);
			return entries.size;
		}
	};
}
