/**
 * ogygia/router — programmatic routing on ogygia's primitives, shaped after SvelteKit.
 *
 * A route table is a record of `pattern → (r) => …`, where the builder `r` carries that key's params
 * (and the accumulated parent data) as TYPES. Each `.load()` cascades its data DOWN; the whole tree is
 * collected UP into a typed `path → { data, params, form }` map you read via `typeof router.$infer`.
 * No codegen. See internal/notes/router.md and router-forms.md.
 *
 *     import { routes } from 'ogygia/router';
 *     export const router = routes((r) =>
 *       r.layout(AppShell).load((c) => ({ user: c.locals?.user }))
 *        .routes({
 *          '/':            (r) => r.page(Home),
 *          '/docs/[slug]': (r) => r.page(Doc).load((c) => ({ doc: getDoc(c.params.slug) })),
 *          '/login':       (r) => r.page(Login).action('submit', login).layout(false),
 *          '/api/[id]':    (r) => r.get((c) => c.json(read(c.params.id))).post(update),
 *        })
 *     );
 *     export type Routes = typeof router.$infer;   // components: let { data, form }: Routes['/docs/[slug]']
 */
export { routes, type Router, type RoutesOptions } from './router.js';
export type {
	Ctx,
	R,
	PageB,
	EndpointB,
	Contribution,
	PageOpts
} from './builder.js';
export type { StandardSchemaV1, InferOutput, Params, HrefArgs, HrefParams } from './view.js';
export { compile, match_path, type CompiledPattern } from './match.js';
