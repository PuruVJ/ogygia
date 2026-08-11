import { z as get_request_store, m as merge_tracing, w as with_request_store, y as try_get_request_store } from '../chunks/utils.js-CNshUuVp.js';
import { b as base } from '../chunks/internal2.js-CRcS4Hsm.js';
import { r as render } from '../chunks/async.js-JxW4IVMW.js';
import '../chunks/internal.js-gg_mc6sK.js';
import '../chunks/routing.js-poy0Ceuj.js';
import { v as verify, b as b64urlDecode, s as secret } from '../chunks/payload.js-BiRFERCp.js';
import * as devalue from 'devalue';
import '../chunks/shared.js-B5OSxjL7.js';

/** @import { Handle, RequestEvent, ResolveOptions } from '@sveltejs/kit' */
/** @import { MaybePromise } from 'types' */

/**
 * A helper function for sequencing multiple `handle` calls in a middleware-like manner.
 * The behavior for the `handle` options is as follows:
 * - `transformPageChunk` is applied in reverse order and merged
 * - `preload` is applied in forward order, the first option "wins" and no `preload` options after it are called
 * - `filterSerializedResponseHeaders` behaves the same as `preload`
 *
 * ```js
 * /// file: src/hooks.server.js
 * import { sequence } from '@sveltejs/kit/hooks';
 *
 * /// type: import('@sveltejs/kit').Handle
 * async function first({ event, resolve }) {
 * 	console.log('first pre-processing');
 * 	const result = await resolve(event, {
 * 		transformPageChunk: ({ html }) => {
 * 			// transforms are applied in reverse order
 * 			console.log('first transform');
 * 			return html;
 * 		},
 * 		preload: () => {
 * 			// this one wins as it's the first defined in the chain
 * 			console.log('first preload');
 * 			return true;
 * 		}
 * 	});
 * 	console.log('first post-processing');
 * 	return result;
 * }
 *
 * /// type: import('@sveltejs/kit').Handle
 * async function second({ event, resolve }) {
 * 	console.log('second pre-processing');
 * 	const result = await resolve(event, {
 * 		transformPageChunk: ({ html }) => {
 * 			console.log('second transform');
 * 			return html;
 * 		},
 * 		preload: () => {
 * 			console.log('second preload');
 * 			return true;
 * 		},
 * 		filterSerializedResponseHeaders: () => {
 * 			// this one wins as it's the first defined in the chain
 * 			console.log('second filterSerializedResponseHeaders');
 * 			return true;
 * 		}
 * 	});
 * 	console.log('second post-processing');
 * 	return result;
 * }
 *
 * export const handle = sequence(first, second);
 * ```
 *
 * The example above would print:
 *
 * ```
 * first pre-processing
 * first preload
 * second pre-processing
 * second filterSerializedResponseHeaders
 * second transform
 * first transform
 * second post-processing
 * first post-processing
 * ```
 *
 * @param {...Handle} handlers The chain of `handle` functions
 * @returns {Handle}
 */
function sequence(...handlers) {
	const length = handlers.length;
	if (!length) return ({ event, resolve }) => resolve(event);

	return ({ event, resolve }) => {
		const { state } = get_request_store();
		return apply_handle(0, event, {});

		/**
		 * @param {number} i
		 * @param {RequestEvent} event
		 * @param {ResolveOptions | undefined} parent_options
		 * @returns {MaybePromise<Response>}
		 */
		function apply_handle(i, event, parent_options) {
			const handle = handlers[i];

			return state.tracing.record_span({
				name: `sveltekit.handle.sequenced.${handle.name ? handle.name : i}`,
				attributes: {},
				fn: async (current) => {
					const traced_event = merge_tracing(event, current);
					return await with_request_store({ event: traced_event, state }, () =>
						handle({
							event: traced_event,
							resolve: (event, options) => {
								/** @type {ResolveOptions['transformPageChunk']} */
								const transformPageChunk = async ({ html, done }) => {
									if (options?.transformPageChunk) {
										html = (await options.transformPageChunk({ html, done })) ?? '';
									}

									if (parent_options?.transformPageChunk) {
										html = (await parent_options.transformPageChunk({ html, done })) ?? '';
									}

									return html;
								};

								/** @type {ResolveOptions['filterSerializedResponseHeaders']} */
								const filterSerializedResponseHeaders =
									parent_options?.filterSerializedResponseHeaders ??
									options?.filterSerializedResponseHeaders;

								/** @type {ResolveOptions['preload']} */
								const preload = parent_options?.preload ?? options?.preload;

								return i < length - 1
									? apply_handle(i + 1, event, {
											transformPageChunk,
											filterSerializedResponseHeaders,
											preload
										})
									: resolve(event, {
											transformPageChunk,
											filterSerializedResponseHeaders,
											preload
										});
							}
						})
					);
				}
			});
		}
	};
}

//#region \0virtual:ogygia/server-manifest
var islands = {
	"defe9ef21fd5": () => import('../chunks/defe9ef21fd5.js-DE-bdm8r.js'),
	"17b26dfcaa86": () => import('../chunks/17b26dfcaa86.js-BCihWW8w.js'),
	"be1d4b28abaf": () => import('../chunks/be1d4b28abaf.js-CQkE0Ksf.js')
};
//#endregion
//#region ../packages/ogygia/dist/hooks.js
/**
* @param {Object} [options]
* @param {string} [options.endpoint] path (relative to base) the handle serves; default is the
*   clash-safe island-emoji route. Must start with `/`.
* @returns {import('@sveltejs/kit').Handle}
*/
function ogygiaHandle(options = {}) {
	const endpoint = (base || "") + (options.endpoint || "/🏝️ogygia🏝️");
	return async ({ event, resolve }) => {
		if (decodeURIComponent(event.url.pathname) !== endpoint) {
			const store = try_get_request_store();
			return resolve(event, { transformPageChunk: async ({ html }) => inject_remote_seed(html, store?.state) });
		}
		return await render_island(event.url);
	};
}
/**
* Collect SSR-resolved implicit query responses from the request store and inject them as a
* side-channel script. Only regular queries (`type: 'query'`) are seeded — `query.live` still
* connects and `.refresh()` still re-fetches. Skips pages Kit already booted (csr===true), which
* carry Kit's own remote serialization.
*/
async function inject_remote_seed(html, state) {
	if (!state || /__sveltekit_/.test(html)) return html;
	const implicit = state.remote?.implicit;
	if (!implicit) return html;
	const q = {};
	for (const [internals, record] of implicit) {
		if (!internals.id || internals.type !== "query") continue;
		for (const key in record) {
			const remote_key = internals.id + "/" + key;
			const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
			let resolved = true;
			await Promise.race([Promise.resolve(promise).then((v) => {
				if (resolved) q[remote_key] = { v };
			}, () => {}), Promise.resolve().then(() => {
				resolved = false;
			})]);
		}
	}
	if (Object.keys(q).length === 0) return html;
	const transport = state.transport || {};
	const reducers = Object.fromEntries(Object.entries(transport).map(([name, codec]) => [name, codec.encode]));
	const script = `<script type="application/ogygia-remote">${devalue.stringify({ q }, reducers).replaceAll("<", "\\u003C")}<\/script>`;
	return html.includes("</body>") ? html.replace("</body>", script + "</body>") : html + script;
}
/**
* @param {URL} url
* @returns {Promise<Response>}
*/
async function render_island(url) {
	const id = url.searchParams.get("id");
	const payload = url.searchParams.get("props") ?? "";
	const sig = url.searchParams.get("sig") ?? "";
	const load = id ? islands[id] : void 0;
	if (!load) return new Response("Unknown island", { status: 404 });
	if (!verify(secret, payload, sig)) return new Response("Invalid island signature", { status: 403 });
	let props;
	try {
		props = devalue.parse(b64urlDecode(payload));
	} catch {
		return new Response("Invalid island payload", { status: 400 });
	}
	let body;
	try {
		const mod = await load();
		body = (await render(mod.default, { props })).body;
	} catch (err) {
		return new Response("Island render failed", { status: 500 });
	}
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "private, max-age=30"
		}
	});
}
//#endregion
//#region src/hooks.server.ts
var passthrough = async ({ event, resolve }) => resolve(event);
var handle = sequence(ogygiaHandle(), passthrough);

export { handle };
//# sourceMappingURL=hooks.server.js-Y0oU4JU5.js.map
