// Shim for `$app/paths` used in the standalone island client build (no sveltekit()).
// The plugin rewrites the empty strings below to the app's real base/assets at build time.
export const base = '';
export const assets = '';
export function resolveRoute(id, params = {}) {
	return id.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, spread, name) => {
		const key = name.split('=')[0];
		return params[key] ?? '';
	});
}
export function asset(path) {
	return (assets || base) + path;
}
