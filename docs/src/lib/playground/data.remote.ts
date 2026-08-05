import { query, command } from '$app/server';

// Remote functions backing the /playground/data demos. No external schema library is used here:
// arguments are declared `'unchecked'` (typed, but not runtime-validated) and any checking is done
// by hand inside the function. That keeps the docs app's dependency list untouched.

// --- query with an argument (seeded from SSR) -------------------------------------------------
// Awaited outside a pending boundary in ResolvedGreeting.svelte, so it resolves during SSR and its
// result is seeded into the client cache on hydration (prod) — no re-fetch, no flash.
export const getGreeting = query('unchecked', async (name: string) => {
	await new Promise((r) => setTimeout(r, 20));
	return { greeting: `Hello, ${name}!`, at: new Date() };
});

// --- command + query + refresh ----------------------------------------------------------------
// In-memory server counter, read by a query and mutated by a command. After a command the island
// calls `.refresh()` to re-read.
let counter = 0;
export const getCount = query(async () => counter);
export const bump = command('unchecked', async (by: number) => {
	counter += by;
	return counter;
});

// --- query.batch ------------------------------------------------------------------------------
// N simultaneous calls in the same macrotask collapse into ONE request. The batch fn runs once with
// every argument and returns a per-argument resolver. `batchAt` is captured once per run, so an
// identical `batchAt` across results proves a single batched request.
export const getSquare = query.batch('unchecked', async (nums: number[]) => {
	const batchAt = Date.now();
	const size = nums.length;
	return (n: number) => ({ n, square: n * n, batchAt, size });
});

// --- query.live -------------------------------------------------------------------------------
// A streaming server clock (async generator) delivered over SSE. `.current` updates each tick.
export const clock = query.live(async function* () {
	while (true) {
		yield new Date().toISOString();
		await new Promise((r) => setTimeout(r, 1000));
	}
});
