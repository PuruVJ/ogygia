/**
 * `federation()` — fragment federation, for `ogygia({ plugins: [federation()] })` in vite.config.
 * Its server realm serves the federation protocol from the handle; `federate({ … })` in
 * hooks.server.ts declares the app's identity and peers. This app's island entries keep their
 * foreign-hydrate exports, so a peer's page can host and wake them.
 */
import { definePlugin, type OgygiaPlugin } from 'ogygia/vite';

export function federation(): OgygiaPlugin {
	return definePlugin({
		name: '@ogygia/federation',
		// federation is built on the server router, which ships `.svelte`: server-inlined like a listed
		// plugin even when the app does not list `router()` itself
		vite: [{ name: 'ogygia:federation', config: () => ({ ssr: { noExternal: ['@ogygia/router'] } }) }],
		build(b) {
			b.foreignHydrate();
		}
	});
}
