import { highlight } from '$lib/code/highlight.server.js';
import * as snip from '$lib/code/snippets.js';

export async function load() {
	const [
		heroCode,
		loadCode,
		idleCode,
		visibleCode,
		mediaCode,
		serverCode,
		viteConfigHtml,
		svelteConfigHtml,
		layoutAndHooksHtml,
		authoringImportsHtml,
		ogygiaRouterHtml,
		persistNavHtml
	] = await Promise.all([
		highlight(snip.hydrateLoadCounter, 'svelte'),
		highlight(snip.hydrateLoad, 'svelte'),
		highlight(snip.hydrateIdle, 'svelte'),
		highlight(snip.hydrateVisible, 'svelte'),
		highlight(snip.hydrateMedia, 'svelte'),
		highlight(snip.deferLoadGreeting, 'svelte'),
		highlight(snip.viteConfig, 'typescript'),
		highlight(snip.svelteConfig, 'javascript'),
		highlight(snip.layoutAndHooks, 'typescript'),
		highlight(snip.authoringImports, 'svelte'),
		highlight(snip.ogygiaRouter, 'svelte'),
		highlight(snip.persistNav, 'html')
	]);

	return {
		heroCode,
		loadCode,
		idleCode,
		visibleCode,
		mediaCode,
		serverCode,
		viteConfigHtml,
		svelteConfigHtml,
		layoutAndHooksHtml,
		authoringImportsHtml,
		ogygiaRouterHtml,
		persistNavHtml
	};
}
