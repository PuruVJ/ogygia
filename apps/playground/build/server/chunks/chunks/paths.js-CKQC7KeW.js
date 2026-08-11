import './internal.js-gg_mc6sK.js';
import { a as assets, b as base, i as initial_base } from './internal2.js-CRcS4Hsm.js';
import { i as resolve_route, c as add_data_suffix } from './routing.js-poy0Ceuj.js';
import { y as try_get_request_store } from './utils.js-CNshUuVp.js';

//#region ../node_modules/.pnpm/@sveltejs+kit@2.70.2_@sveltejs+vite-plugin-svelte@7.2.0_svelte@5.56.8_vite@8.2.0_@types_b82a031257a225430218912b412880c1/node_modules/@sveltejs/kit/src/runtime/app/paths/server.js
/** @type {import('./client.js').asset} */
function asset(file) {
	return assets && assets !== base ? assets + file : resolve(file);
}
/** @type {import('./client.js').resolve} */
function resolve(id, params) {
	if (!id.startsWith("/")) throw new Error(`Cannot use \`resolve(...)\` with a non-absolute pathname or route ID (got "${id}"). \`resolve\` is only for internal pathnames and route IDs; external URLs should be used directly.`);
	const resolved = resolve_route(id, params);
	{
		const store = try_get_request_store();
		if (store && !store.state.prerendering?.fallback) return ((store.event.isDataRequest ? add_data_suffix(store.event.url.pathname) : store.event.url.pathname).slice(initial_base.length).split("/").slice(2).map(() => "..").join("/") || ".") + resolved;
	}
	return base + resolved;
}

export { asset as a, resolve as r };
//# sourceMappingURL=paths.js-CKQC7KeW.js.map
