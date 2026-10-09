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
export { routes, when, type Router, type RoutesOptions } from './router.js';
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
export { anonymousVisitor, type AnonymousVisitorOptions } from './visitor.js';
export { api, ApiError, type ApiClient, type ApiClientOptions } from './client-api.js';

// Fragment federation v2 lives in `ogygia/federation` (`federate()` — one identity per app, remote
// fragments as region values, cross-app thaw). `mount()` is router glue, so it (and `user`) are
// re-exported here for the shell's route table. Imported from the leaf modules (NOT the federation
// barrel) so the router graph never pulls the handle-only `serve.js` + its server virtuals. Design:
// internal/notes/federation.md.
export { mount, type MountOptions, type KitMountOptions } from '../federation/mount.js';
export { user, sign_headers, child_traceparent } from '../federation/wire.js';
export type { Peer } from '../federation/types.js';
export type { Claims, FragmentDocument, WidgetDocument, VerifyConfig } from '../federation/wire.js';
