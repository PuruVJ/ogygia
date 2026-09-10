/**
 * freeze — tier-1 store: in-process byte-bounded LRU with TTL backstop + the tag reverse index
 * (og.source receipts). The zero-infra default (`ogygia({ freeze: true })` with no
 * `configure()`): single-instance adapter-node. Replicas / serverless want tier 2 (valkey /
 * upstash) — a per-instance LRU there means per-instance misses AND invalidation blind spots.
 */
import type { FreezeEntry, FreezePutOptions, FreezeStore } from './types.js';
import { normalize_prefix } from './key.js';
import { SizedLru } from '../server/sized-lru.js';

/** Resident budget for frozen pages (a stored page can be multi-MB; a count alone bounds nothing). */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;

/** What an entry costs to keep: a page is its HTML; a redirect is a few dozen bytes. */
const entry_bytes = (entry: FreezeEntry): number =>
	entry.kind === 'page' ? entry.html.length : 64;

export function memory_store(
	max_entries = DEFAULT_MAX_ENTRIES,
	max_bytes = DEFAULT_MAX_BYTES
): FreezeStore {
	const entries = new SizedLru<FreezeEntry>(max_bytes, max_entries);
	// tag → keys (og.source receipts). Dead keys are tolerated (evicted entries leave their tag
	// refs behind; a later evictByTag deleting a gone key is a no-op) — no sweep bookkeeping.
	const tag_index = new Map<string, Set<string>>();

	return {
		async get(key) {
			return entries.get(key, Date.now());
		},
		async put(key, entry, options: FreezePutOptions) {
			entries.set(key, entry, entry_bytes(entry), Date.now() + options.ttl * 1000);
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
			entries.sweep(Date.now());
			return entries.size;
		}
	};
}
