import { query, getRequestEvent } from '$app/server';

// The "horribly complex, cookie-level" server read the live header depends on. It runs
// server-side WHEREVER the header renders: during the page render (anonymous capture — the
// cookie read returns undefined = DEFAULT, so the vary law still stores the canonical) and
// during the live REVALIDATION render (the region endpoint — the browser's fetch carries the
// visitor's cookies, so this sees them; per-request, never observed).
export const whoami = query(async () => {
	const { cookies } = getRequestEvent();
	return {
		user: cookies.get('user') ?? null,
		at: new Date().toISOString()
	};
});
