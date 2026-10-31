import { query, getRequestEvent } from '$app/server';

// A remote query used INSIDE a server island. It runs during the deferred render (the
// `/_islands` endpoint), reading the request cookies for personalization and simulating
// slow data (300ms). Because it runs in-process on the server, `getRequestEvent()` sees
// the cookies the browser sent with the island fetch.
export const personalGreeting = query(async () => {
	const { cookies } = getRequestEvent();
	const name = cookies.get('sk_name') || 'stranger';
	await new Promise((r) => setTimeout(r, 300)); // artificially slow data
	return { name, at: new Date().toISOString() };
});
