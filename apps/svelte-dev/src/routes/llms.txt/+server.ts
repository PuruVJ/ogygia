import { docs } from '$lib/site.server';

// llms.txt index (llmstxt.org) over the whole docs corpus — ogygia emits it from the nav tree.
export const prerender = true;

export const GET = docs.emit.llms({
	title: 'Svelte',
	description: 'Docs for Svelte, SvelteKit, and the Svelte CLI.'
});
