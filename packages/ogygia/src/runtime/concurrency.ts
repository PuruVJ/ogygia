/**
 * Shared concurrency gate — client region fetches (SI-STORM) and server region SSR (M1).
 * Caps in-flight work; waiters queue FIFO. Does not cancel running work (see INVARIANTS.md).
 */
export class ConcurrencyGate {
	#limit: number;
	#active = 0;
	#wait: Array<() => void> = [];

	constructor(max: number) {
		this.#limit = Math.max(1, max);
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#active >= this.#limit) {
			await new Promise<void>((resolve) => this.#wait.push(resolve));
		}
		this.#active++;
		try {
			return await fn();
		} finally {
			this.#active--;
			this.#wait.shift()?.();
		}
	}

	get active() {
		return this.#active;
	}
}

/** Max concurrent region SSR renders per process (CPU amp under valid MAC). */
export const REGION_RENDER_CONCURRENCY = 4;
