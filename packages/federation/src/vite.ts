/**
 * `federation()` — fragment federation, listed beside `ogygia()` in vite.config `plugins`.
 * Its server realm serves the federation protocol from the handle; `federate({ … })` in
 * hooks.server.ts declares the app's identity and peers. This app's island entries keep their
 * foreign-hydrate exports, so a peer's page can host and wake them.
 */
import type { Plugin as VitePlugin } from 'vite';
import { definePlugin, type OgygiaPlugin } from '@ogygia/core/vite';

export function federation(): [OgygiaPlugin, VitePlugin] {
	return [
		definePlugin({
			name: '@ogygia/federation',
			server: import.meta.resolve('./server.ts'),
			build(b) {
				b.foreignHydrate();
			}
		}),
		// federation is built on the server router, which ships `.svelte`: server-inlined like a listed
		// plugin even when the app does not list `router()` itself
		{ name: 'ogygia:federation', config: () => ({ ssr: { noExternal: ['@ogygia/router'] } }) }
	];
}
