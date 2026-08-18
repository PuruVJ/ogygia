import { redirect } from '@sveltejs/kit';

// `/docs` has no landing of its own — the Shell brand + any bare `/docs` link resolve to the first
// doc. Prerendered as a redirect so the crawler is happy.
export const prerender = true;

export function load() {
	redirect(307, '/docs/start/overview');
}
