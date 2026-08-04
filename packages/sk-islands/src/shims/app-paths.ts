// Shim for `$app/paths` used in the standalone island client build (no sveltekit()).
// Mirrors Kit's MODERN surface: prefer `resolve()` / `asset()`. `base` / `assets` / `resolveRoute`
// are kept as deprecated passthroughs for user code (and our own compat) that still imports them.
// (In standalone mode `base`/`assets` are effectively '' unless the app configures paths.)

/** @deprecated use resolve() */
export const base = '';
/** @deprecated use asset() */
export const assets = '';

function substitute(id: string, params: Record<string, string> = {}) {
	return id.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, _spread, name) => {
		const key = name.split('=')[0];
		return params[key] ?? '';
	});
}

/** Modern: base-prefix a pathname, or populate a route id's dynamic segments. */
export function resolve(id: string, params: Record<string, string> = {}) {
	return base + substitute(id, params);
}

/** Modern: resolve an asset URL in the static dir. */
export function asset(file: string) {
	return (assets || base) + file;
}

/** @deprecated use resolve() */
export const resolveRoute = resolve;
