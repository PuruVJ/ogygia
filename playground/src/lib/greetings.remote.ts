import { query, command } from '$app/server';
import * as v from 'valibot';

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

// Live query: streaming server clock (async generator).
export const clock = query.live(async function* () {
	while (true) {
		yield new Date().toISOString();
		await new Promise((r) => setTimeout(r, 1000));
	}
});
