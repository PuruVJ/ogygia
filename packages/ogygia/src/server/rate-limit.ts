/**
 * Shared rate-limit bucket for the region endpoint.
 * - Hard-caps map size with amortized random eviction.
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

	#drop_one() {
		const idx = (Math.random() * this.#buckets.size) | 0;
		let i = 0;
		for (const k of this.#buckets.keys()) {
			if (i++ === idx) {
				this.#buckets.delete(k);
				return;
			}
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
		while (this.#buckets.size > this.#cap) this.#drop_one();
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
		if (b.n >= this.#max) return true;
		b.n++;
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
