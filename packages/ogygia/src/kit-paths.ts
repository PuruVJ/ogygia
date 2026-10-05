/**
 * KIT'S `asset()` FOR OGYGIA'S URLS. ogygia bakes every URL base-less with a leading slash
 * (`/_app/immutable/…`, `/@id/…`) and runs it through Kit's `asset()` at render — the one authority on
 * the base, the assets CDN and page-relative paths. Kit 2 takes the path with its leading slash (and
 * throws without it); Kit 3 takes it without (and warns on every call with it, in dev — one warning
 * per island render).
 *
 * No version is read: the first call tries the path without its slash, and a Kit that refuses it gets
 * the slash from then on. (Drop the fallback with Kit 2.)
 */
import { asset } from '$app/paths';

/** this Kit wants the leading slash (it refused the path without one); null until the first call */
let wants_slash: boolean | null = null;

/** Kit's `asset()` for a base-less URL ogygia baked (`/_app/immutable/x.js`). */
export function kit_asset(file: string): string {
	const call = asset as (f: string) => string;
	if (!file.startsWith('/')) return call(file);
	if (wants_slash === null) {
		try {
			const out = call(file.slice(1));
			wants_slash = false;
			return out;
		} catch {
			wants_slash = true;
		}
	}
	return call(wants_slash ? file : file.slice(1));
}
