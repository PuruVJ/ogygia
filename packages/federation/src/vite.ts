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
		build(b) {
			b.foreignHydrate();
		}
	});
}
