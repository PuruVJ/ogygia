/**
 * `router()` — the server router, for `ogygia({ plugins: [router()] })` in vite.config. A `routes()` table
 * renders pages outside Kit's routes, so nothing file-derived links their components' CSS: listing the
 * plugin tells the build that every module importing `@ogygia/router` is a page module, and every
 * component it can reach gets its whole-tree CSS linked when it renders. It also makes the package the
 * app's own code to the build (server-inlined: it ships `.svelte`).
 */
import { definePlugin, type OgygiaPlugin } from 'ogygia/vite';

export function router(): OgygiaPlugin {
	return definePlugin({
		name: '@ogygia/router',
		build(b) {
			b.pageModules({ importers: ['@ogygia/router'] });
		}
	});
}
