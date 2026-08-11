import { query, command } from '$app/server';

// In-memory server state (per server instance). A `query` reads it; two `command`s mutate it. Every
// call is a real round-trip to the server — open this page in two tabs and the count is shared.
let count = 3;

export const getCount = query(async () => count);

export const bump = command(async () => {
	count += 1;
	return count;
});

export const reset = command(async () => {
	count = 0;
	return count;
});
