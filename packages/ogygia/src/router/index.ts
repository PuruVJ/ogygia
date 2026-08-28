/**
 * ogygia/router — Kit's routing model, expressed as values (v2). No filesystem convention, no
 * codegen: you import functions, build a flat table, export the router + its `$infer` type map.
 *
 *     import { routes, layout, page, load, action, get, redirect, error, fail } from 'ogygia/router';
 *
 *     const shell = layout('app', AppShell, { load: async (c) => ({ user: c.locals?.user }) });
 *
 *     export const app = routes(
 *       shell({
 *         '/':            page(Home),
 *         '/docs/[slug]': page(Doc, { load: async (c) => ({ doc: await docs.get(c.params.slug) }) }),
 *         '/login':       page(Login, { actions: { default: login } }),
 *         '/api/[id]':    get((c) => c.json(read(c.params.id))).post(update),
 *       }),
 *       { base: '', error: ErrorPage }
 *     );
 *     export type App = typeof app.$infer;   // components: let { data }: App['/docs/[slug]']
 *
 * See internal/notes/router-v2.md for the full design + the Kit ↔ v2 dictionary.
 */
export { routes, type Router, type RoutesOptions } from './router.js';
export {
	load,
	action,
	page,
	layout,
	GET,
	POST,
	PUT,
	DELETE,
	PATCH,
	type Load,
	type Action,
	type Handler,
	type VerbEntry,
	type Endpoint,
	type LoadDef,
	type ActionDef,
	type LayoutDef,
	type PageDef,
	type PageServer,
	type RouteTable
} from './define.js';
export { redirect, error, fail, type ActionFailure } from './respond.js';
export type { Ctx } from './ctx.js';
export type { InferMap } from './infer.js';
export type {
	StandardSchemaV1,
	InferOutput,
	Params,
	HrefArgs,
	HrefParams,
	Simplify
} from './view.js';
export { compile, match_path, type CompiledPattern } from './match.js';

// EXPERIMENTAL — fragment federation: an MFE `expose()`s its route tree; the shell makes ONE
// `client()` per MFE (signing / timeout / SWR cache / coalescing / generation-safe invalidation)
// and consumes it three ways — `mount(client)` as one table entry, `client.widget()` in its own
// SSR stitch, `proxy({ app })` as the lazy client-stitch endpoint. Ed25519 caller signing +
// signature-bound visitor claims (`user(c)`, auto-built from `c.visitor` + the table's
// experiments) + W3C trace continuity ride the same hop. Design + POC log: internal/notes/mfe.md.
export {
	expose,
	catalog,
	client,
	mount,
	kitMount,
	proxy,
	sign_headers,
	verify_fragment_request,
	user,
	child_traceparent,
	FRAGMENT_ROUTES_PATH,
	type FragmentDocument,
	type FragmentClient,
	type ClientOptions,
	type WidgetDocument,
	type MountOptions,
	type KitMountOptions,
	type ProxyOptions,
	type Widget,
	type WidgetInfo,
	type Claims,
	type VerifyConfig
} from './fragment.js';
