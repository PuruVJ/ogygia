// Shim for `$app/paths` used in the standalone island client build (no sveltekit()).
// Mirrors Kit's surface: `resolve()` / `asset()`, plus `base` / `assets` for Kit remotes
// and server pathname matching. (In standalone mode they are '' unless the app configures paths.)

export const base = '';
export const assets = '';

const ROUTE_PARAM = /\[(\.\.\.)?([^\]]+)\]/g;

function substitute(id: string, params: Record<string, string> = {}) {
	return id.replace(ROUTE_PARAM, (_, _spread, name) => {
		const key = name.split('=')[0];
		return params[key] ?? '';
	});
}

/** Base-prefix a pathname, or populate a route id's dynamic segments. */
export function resolve(id: string, params: Record<string, string> = {}) {
	return base + substitute(id, params);
}

/** Resolve an asset URL in the static dir. */
export function asset(file: string) {
	return (assets || base) + file;
}
