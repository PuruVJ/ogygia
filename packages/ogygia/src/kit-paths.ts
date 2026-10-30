/**
 * KIT'S `asset()` FOR OGYGIA'S URLS. ogygia bakes every URL base-less with a leading slash
 * (`/_app/immutable/…`, `/@id/…`) and runs it through Kit's `asset()` at render — the one authority on
 * the base, the assets CDN and page-relative paths. Kit takes the path without its leading slash (and
 * warns on every call with one, in dev).
 *
 * Inside a remote QUERY Kit's relative `asset()` throws (it reads `event.url`, which a query may not:
 * `remote_request_property`). A region a query renders lands in a page at any depth anyway, so there
 * the URL is root-absolute — Kit's configured assets dir or base, from its build defines.
 */
import { asset, resolve } from '$app/paths';
import { in_remote_query } from './server/kit-context.js';

declare const __SVELTEKIT_PATHS_BASE__: string;
declare const __SVELTEKIT_PATHS_ASSETS__: string;

const base = () => (typeof __SVELTEKIT_PATHS_BASE__ !== 'undefined' ? __SVELTEKIT_PATHS_BASE__ : '');

/** Kit's `asset()` for a base-less URL ogygia baked (`/_app/immutable/x.js`). */
export function kit_asset(file: string): string {
	const bare = file.startsWith('/') ? file.slice(1) : file;
	if (in_remote_query()) {
		const assets = typeof __SVELTEKIT_PATHS_ASSETS__ !== 'undefined' && __SVELTEKIT_PATHS_ASSETS__ ? __SVELTEKIT_PATHS_ASSETS__ : base();
		return assets + '/' + bare;
	}
	return asset(bare as Parameters<typeof asset>[0]);
}

/** Kit's `resolve()` for one of ogygia's own app paths (`/__ogygia__`) — root-absolute in a remote query. */
export function kit_resolve(pathname: string): string {
	return in_remote_query() ? base() + pathname : resolve(pathname as Parameters<typeof resolve>[0]);
}
