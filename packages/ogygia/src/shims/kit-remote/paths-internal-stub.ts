// Stub for `$app/paths/internal/client` — Kit's remote-functions client reads `base` + `app_dir`
// from here to build the POST URL `${base}/${app_dir}/remote/<id>`. We read SvelteKit's own build
// defines (the same ones its real module reads) so a custom `paths.base` / `appDir` is honoured —
// a hardcoded `_app` (or empty base) would send island remote calls to a 404. The `typeof` guards
// keep it working in the standalone island build too, where the defines are absent (defaults apply).
// `base`/`assets` here are the app-origin paths (remote endpoints are served by the SSR handler),
// NOT the immutable-asset prefix (which may point at a CDN).
declare const __SVELTEKIT_APP_DIR__: string;
declare const __SVELTEKIT_PATHS_BASE__: string;
declare const __SVELTEKIT_PATHS_ASSETS__: string;

export const base = typeof __SVELTEKIT_PATHS_BASE__ !== 'undefined' ? __SVELTEKIT_PATHS_BASE__ : '';
export const assets =
	typeof __SVELTEKIT_PATHS_ASSETS__ !== 'undefined' && __SVELTEKIT_PATHS_ASSETS__
		? __SVELTEKIT_PATHS_ASSETS__
		: base;
export const app_dir = typeof __SVELTEKIT_APP_DIR__ !== 'undefined' ? __SVELTEKIT_APP_DIR__ : '_app';
