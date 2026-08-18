import { docs } from '$lib/docs.server';

// The docs, as an llms.txt index for models (llmstxt.org). One line off the site — the nav tree
// serialized with titles + summaries. Prerendered; canonical origin for stable absolute URLs.
export const prerender = true;

export const GET = docs.emit.llms({
	base: '/docs',
	origin: 'https://ogygia.puruvj.dev',
	title: 'Ogygia',
	description: 'Astro-style SSR islands for SvelteKit — no Kit patches.'
});
