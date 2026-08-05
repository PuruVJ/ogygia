import { query, getRequestEvent } from '$app/server';

// Read a cookie during the deferred server-island render. Remote functions run with the request
// context of the island fetch, so cookies flow. Returns the personalized name (or a default) plus
// the server render time.
export const whoAmI = query(async () => {
	const { cookies } = getRequestEvent();
	const name = cookies.get('pg_name') ?? 'voyager';
	return { name, at: new Date().toLocaleTimeString() };
});
