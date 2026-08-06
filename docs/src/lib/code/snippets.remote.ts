import { prerender } from '$app/server';
import * as snip from '$lib/code/snippets.js';

/**
 * Shiki-highlight docs/playground snippet sources once at build (`prerender()`), then serve the
 * baked HTML on every SSR request. The rest of the docs app stays dynamic (`prerender = false`)
 * so remotes, cookies, and defer holes keep working without BrowserGate gymnastics.
 *
 * `dynamic: true` is required because these pages are not themselves prerendered — without it Kit
 * has no static response to return at request time.
 *
 * Highlight is dynamic-imported so the request path that only reads the baked remote never loads
 * Shiki (no static edge into `highlight.server.ts` / `shiki` from this module).
 */
export const docsPageSnippets = prerender(
	async () => {
		const { highlight } = await import('$lib/code/highlight.server.js');
		const [
			heroCode,
			loadCode,
			idleCode,
			visibleCode,
			mediaCode,
			serverCode,
			serverIdleCode,
			serverVisibleCode,
			serverMediaCode,
			viteConfigHtml,
			pluginConfigHtml,
			layoutAndHooksHtml,
			adoptionMigrateHtml,
			authoringImportsHtml,
			ogygiaRouterHtml,
			ogygiaBoundaryHtml,
			persistNavHtml,
			remountConfigHtml
		] = await Promise.all([
			highlight(snip.hydrateLoadCounter, 'svelte'),
			highlight(snip.hydrateLoad, 'svelte'),
			highlight(snip.hydrateIdle, 'svelte'),
			highlight(snip.hydrateVisible, 'svelte'),
			highlight(snip.hydrateMedia, 'svelte'),
			highlight(snip.deferLoadGreeting, 'svelte'),
			highlight(snip.deferIdleGreeting, 'svelte'),
			highlight(snip.deferVisibleGreeting, 'svelte'),
			highlight(snip.deferMediaGreeting, 'svelte'),
			highlight(snip.viteConfig, 'typescript'),
			highlight(snip.pluginConfig, 'typescript'),
			highlight(snip.layoutAndHooks, 'typescript'),
			highlight(snip.adoptionMigrate, 'typescript'),
			highlight(snip.authoringImports, 'svelte'),
			highlight(snip.ogygiaRouter, 'svelte'),
			highlight(snip.ogygiaBoundary, 'svelte'),
			highlight(snip.persistNav, 'html'),
			highlight(snip.remountConfig, 'typescript')
		]);

		return {
			heroCode,
			loadCode,
			idleCode,
			visibleCode,
			mediaCode,
			serverCode,
			serverIdleCode,
			serverVisibleCode,
			serverMediaCode,
			viteConfigHtml,
			pluginConfigHtml,
			layoutAndHooksHtml,
			adoptionMigrateHtml,
			authoringImportsHtml,
			ogygiaRouterHtml,
			ogygiaBoundaryHtml,
			persistNavHtml,
			remountConfigHtml
		};
	},
	{ dynamic: true }
);

export const strategiesPageSnippets = prerender(
	async () => {
		const { highlight } = await import('$lib/code/highlight.server.js');
		const [loadCode, idleCode, visibleCode, mediaCode, presetCode] = await Promise.all([
			highlight(snip.hydrateLoad, 'svelte'),
			highlight(snip.hydrateIdle, 'svelte'),
			highlight(snip.hydrateVisible, 'svelte'),
			highlight(snip.hydrateMedia, 'svelte'),
			highlight(snip.presetDemo, 'svelte')
		]);

		return { loadCode, idleCode, visibleCode, mediaCode, presetCode };
	},
	{ dynamic: true }
);
