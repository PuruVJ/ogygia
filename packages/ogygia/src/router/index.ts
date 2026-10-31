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
export { routes, when, type Router, type RoutesOptions } from './router.ts';
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
} from './define.ts';
export { redirect, error, fail, type ActionFailure } from './respond.ts';
export type { Ctx } from './ctx.ts';
export type { InferMap } from './infer.ts';
export type {
	StandardSchemaV1,
	InferOutput,
	Params,
	HrefArgs,
	HrefParams,
	Simplify
} from './view.ts';
export { compile, match_path, type CompiledPattern } from './match.ts';
export { anonymousVisitor, type AnonymousVisitorOptions } from './visitor.ts';
export { api, ApiError, type ApiClient, type ApiClientOptions } from './client-api.ts';

// (fragment federation — `federate()`, `mount()`, `user` — is its own plugin: `@ogygia/federation`)
// For plugins that build on the router:
export { is_http_error as isHttpError, is_redirect as isRedirect } from './respond.ts';
export type { ComponentPick, AnyComponent } from './define.ts';
