/**
 * A byte-bounded LRU with per-entry expiry — THE in-process cache shape ogygia's server-side
 * memos share (the region render cache, the freeze tier-1 store).
 *
 * Bounded by BYTES first, entry count second. A count-only bound is no bound on memory when an
 * entry can be a whole 2.6 MB page: 500 renders or 1,000 frozen pages of that size would be
 * gigabytes resident in a long-lived process. Here the caller sizes each entry (`html.length` is
 * exact enough — one UTF-16 unit per char, twice that in memory) and the store evicts the least
 * recently used entries until the new one fits; an entry larger than the whole budget is refused.
 *
 * Map iteration order is insertion order → delete + set on every hit makes it an LRU.
 */
interface Entry<V> {
	value: V;
	bytes: number;
	expires: number;
}

export class SizedLru<V> {
	readonly #entries = new Map<string, Entry<V>>();
	#bytes = 0;

	constructor(
		readonly max_bytes: number,
		readonly max_entries: number
	) {}

	/** The live value for `key` (an LRU touch), or `null` on a miss or past `expires`. */
	get(key: string, now: number): V | null {
		const e = this.#entries.get(key);
		if (e === undefined) return null;
		if (now >= e.expires) {
			this.delete(key);
			return null;
		}
		this.#entries.delete(key);
		this.#entries.set(key, e);
		return e.value;
	}

	has(key: string): boolean {
		return this.#entries.has(key);
	}

	/** Store `value` (`bytes` big, live until `expires`), evicting the least recently used entries
	 *  to make room. A value larger than the whole budget is not stored. */
	set(key: string, value: V, bytes: number, expires: number): void {
		this.delete(key);
		if (bytes > this.max_bytes) return;
		while (
			this.#entries.size > 0 &&
			(this.#bytes + bytes > this.max_bytes || this.#entries.size >= this.max_entries)
		) {
			const oldest = this.#entries.keys().next().value as string;
			this.delete(oldest);
		}
		this.#entries.set(key, { value, bytes, expires });
		this.#bytes += bytes;
	}

	delete(key: string): boolean {
		const e = this.#entries.get(key);
		if (e === undefined) return false;
		this.#entries.delete(key);
		this.#bytes -= e.bytes;
		return true;
	}

	/** Every live key (insertion order — least recently used first). */
	keys(): IterableIterator<string> {
		return this.#entries.keys();
	}

	/** Drop everything past `expires` (harness counts want live entries only). */
	sweep(now: number): void {
		for (const [key, e] of this.#entries) if (now >= e.expires) this.delete(key);
	}

	clear(): void {
		this.#entries.clear();
		this.#bytes = 0;
	}

	get size(): number {
		return this.#entries.size;
	}

	get bytes(): number {
		return this.#bytes;
	}
}
