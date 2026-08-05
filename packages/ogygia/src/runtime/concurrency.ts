/**
 * Client concurrency gate for server-island endpoint fetches (SI-STORM).
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
