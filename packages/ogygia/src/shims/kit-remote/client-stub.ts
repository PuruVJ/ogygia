// Plan A stub for Kit's client `client.js`, scoped to Kit's remote-functions importers only.
// Provides exactly what those modules read — WITHOUT pulling Kit's router graph.
import { transport } from 'virtual:ogygia/transport';
import { goto as spaGoto, invalidateAll as spaInvalidateAll } from '../../runtime/router.js';

const t = transport || {};
export const app = {
	hooks: { transport: t },
	decoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.decode])),
	encoders: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.encode]))
};
export function goto(url) {
	return spaGoto(url);
}
export const _goto = goto;
export function invalidateAll() {
	return spaInvalidateAll();
}
export function set_nearest_error_page() {}
export const query_map = new Map();
export const live_query_map = new Map();
export const query_responses = {};
export const prerender_responses = {};
