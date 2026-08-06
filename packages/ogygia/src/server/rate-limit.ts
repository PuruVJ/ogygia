/**
 * Shared rate-limit bucket for the region endpoint.
 * - Hard-caps map size with LRU eviction (Map insertion order).
 * - Render limiter: charge AFTER a valid MAC (RATE-BURN).
 * - Probe limiter: charge BEFORE HMAC (HMAC-CPU-DOS).
 */
export type RateBucket = { n: number; t: number };

const DEFAULT_CAP = 4096;

export class RateLimiter {
	#buckets = new Map<string, RateBucket>();
	#cap: number;
	#max: number;
	#windowMs: number;
	#since_prune = 0;

	constructor(opts: { max: number; windowMs: number; cap?: number }) {
		this.#max = opts.max;
		this.#windowMs = opts.windowMs;
		this.#cap = Math.max(1, opts.cap ?? DEFAULT_CAP);
	}

	/** Mark `ip` as most-recently used (Map: delete + set → end of iteration order). */
	#touch(ip: string, b: RateBucket) {
		this.#buckets.delete(ip);
		this.#buckets.set(ip, b);
	}

	#evict_lru() {
		while (this.#buckets.size > this.#cap) {
			const oldest = this.#buckets.keys().next().value;
			if (oldest === undefined) return;
			this.#buckets.delete(oldest);
		}
	}

	#maybe_prune(now: number) {
		this.#since_prune++;
		if (this.#since_prune >= 64) {
			this.#since_prune = 0;
			for (const [k, v] of this.#buckets) {
				if (now - v.t >= this.#windowMs) this.#buckets.delete(k);
			}
		}
		this.#evict_lru();
	}

	/** @returns true if this IP is over budget (request should 429). */
	limited(ip: string): boolean {
		if (this.#max <= 0) return false;
		const now = Date.now();
		const b = this.#buckets.get(ip);
		if (!b || now - b.t >= this.#windowMs) {
			this.#buckets.set(ip, { n: 1, t: now });
			this.#maybe_prune(now);
			return false;
		}
		if (b.n >= this.#max) {
			this.#touch(ip, b);
			return true;
		}
		b.n++;
		this.#touch(ip, b);
		return false;
	}

	get size() {
		return this.#buckets.size;
	}

	clear() {
		this.#buckets.clear();
		this.#since_prune = 0;
	}
}
