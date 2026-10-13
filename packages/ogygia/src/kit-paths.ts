/**
 * KIT'S `asset()` FOR OGYGIA'S URLS. ogygia bakes every URL base-less with a leading slash
 * (`/_app/immutable/…`, `/@id/…`) and runs it through Kit's `asset()` at render — the one authority on
 * the base, the assets CDN and page-relative paths. Kit takes the path without its leading slash (and
 * warns on every call with one, in dev).
 */
import { asset } from '$app/paths';

/** Kit's `asset()` for a base-less URL ogygia baked (`/_app/immutable/x.js`). */
export function kit_asset(file: string): string {
	return asset((file.startsWith('/') ? file.slice(1) : file) as Parameters<typeof asset>[0]);
}
