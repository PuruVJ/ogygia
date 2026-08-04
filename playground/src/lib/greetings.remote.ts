import { query, command, prerender } from '$app/server';
import * as v from 'valibot';
import { Temperature } from '../hooks';

// Returns a CUSTOM transport type (see src/hooks.ts). Proves custom types survive the remote
// boundary into an island on the client (Kit's transport decoders, reused via ogygia).
export const getTemperature = query(async () => new Temperature(21.5));

// Query with a validated argument (Standard Schema via valibot).
export const getGreeting = query(v.string(), async (name) => {
	await new Promise((r) => setTimeout(r, 30));
	return { greeting: `Hello, ${name}!`, at: new Date() };
});

// In-memory server state mutated by a command, read by a query (+ .refresh()).
let counter = 0;
export const getCount = query(async () => counter);
export const bump = command(v.number(), async (by) => {
	counter += by;
	return counter;
});

// query.batch: N simultaneous calls in the SAME tick collapse into ONE network request. The batch
// fn runs ONCE with all args and returns a per-arg resolver. `batchAt` is captured once per server
// invocation, so identical `batchAt` across results proves a single batched request/run.
export const getSquare = query.batch(v.number(), async (nums: number[]) => {
	const batchAt = Date.now();
	const size = nums.length;
	return (n: number) => ({ n, square: n * n, batchAt, size });
});

// prerender: a remote function whose result can be baked at build time. `dynamic: true` lets it also
// run at request time on a NON-prerendered page (else it would require a prerendered static file).
export const getManifesto = prerender(
	async () => ({ text: 'islands, not hydration', at: new Date().toISOString() }),
	{ dynamic: true }
);

// Live query: streaming server clock (async generator).
export const clock = query.live(async function* () {
	while (true) {
		yield new Date().toISOString();
		await new Promise((r) => setTimeout(r, 1000));
	}
});
