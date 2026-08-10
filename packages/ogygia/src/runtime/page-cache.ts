/**
 * Bounded SPA HTML cache: TTL + max entries + approximate byte budget.
 * Expired entries are dropped on read/insert; overflow drops oldest by timestamp.
 */
export type PageCacheEntry = { html: string; t: number; bytes: number };

export class PageCache {
	#map = new Map<string, PageCacheEntry>();
	#total_bytes = 0;
	#ttlMs: number;
	#maxEntries: number;
	#maxBytes: number;

	constructor(opts?: { ttlMs?: number; maxEntries?: number; maxBytes?: number }) {
		this.#ttlMs = opts?.ttlMs ?? 8_000;
		this.#maxEntries = opts?.maxEntries ?? 32;
		this.#maxBytes = opts?.maxBytes ?? 4_000_000;
	}

	#drop(href: string) {
		const e = this.#map.get(href);
		if (!e) return;
		this.#map.delete(href);
		this.#total_bytes -= e.bytes;
	}

	#evict_expired(now: number) {
		for (const [href, e] of this.#map) {
			if (now - e.t >= this.#ttlMs) this.#drop(href);
		}
	}

	#evict_overflow() {
		while (this.#map.size > this.#maxEntries || this.#total_bytes > this.#maxBytes) {
			let oldest_href: string | null = null;
			let oldest_t = Infinity;
			for (const [href, e] of this.#map) {
				if (e.t < oldest_t) {
					oldest_t = e.t;
					oldest_href = href;
				}
			}
			if (!oldest_href) break;
			this.#drop(oldest_href);
		}
	}

	get(href: string): string | null {
		const now = Date.now();
		const e = this.#map.get(href);
		if (!e) return null;
		if (now - e.t >= this.#ttlMs) {
			this.#drop(href);
			return null;
		}
		this.#map.delete(href);
		e.t = now;
		this.#map.set(href, e);
		return e.html;
	}

	set(href: string, html: string) {
		const now = Date.now();
		this.#evict_expired(now);
		this.#drop(href);
		const bytes = html.length * 2;
		this.#map.set(href, { html, t: now, bytes });
		this.#total_bytes += bytes;
		this.#evict_overflow();
	}

	delete(href: string) {
		this.#drop(href);
	}

	clear() {
		this.#map.clear();
		this.#total_bytes = 0;
	}

	get size() {
		return this.#map.size;
	}

	get bytes() {
		return this.#total_bytes;
	}
}
