/**
 * `ogygia/plugin/testing` — start a plugin's server realm without a server, for unit tests: its app
 * made, its shared hooks registered, its `setup` run (exactly what the handle does at boot), and a
 * request context to call its hooks with.
 *
 *   const { app, ctx } = startPlugin(server, { name: '@ogygia/flags' });
 *   await server.request?.(ctx(new Request('http://x/')));
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestContext, ServerApp, ServerPlugin } from './index.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { facts_of } from './facts.ts';
import { request_contexts, start_plugins, type AppSigner } from './server.ts';

// ── route options: read the lookup a plugin's `ctx.routeOption()` reads, and set its two worlds up
/** This request's declared value for `option` (a registered router's verdict, else the Kit page's
 *  baked value), or `undefined`. */
export { route_option as routeOption } from './routes.ts';
/** Forget every registered router and every page's declared values. */
export { clear_route_options as clearRouteOptions } from './routes.ts';
/** Stand in for the compiler: the Kit pages' declared values (route id → option → value). */
export { set_page_route_options as setPageRouteOptions } from './routes.ts';

/** A real HMAC under a key made for this test process. */
const TEST_KEY = randomBytes(32);
const TEST_SIGNER: AppSigner = {
	sign: (message) => createHmac('sha256', TEST_KEY).update(message).digest('base64url'),
	verify(message, signature) {
		const want = Buffer.from(createHmac('sha256', TEST_KEY).update(message).digest('base64url'));
		const got = Buffer.from(signature);
		return want.length === got.length && timingSafeEqual(want, got);
	}
};

export interface StartedPlugin<Options, State> {
	app: ServerApp<Options>;
	/** A request context for `request` (a bare event: url, request, cookies that read nothing). */
	ctx(request: Request, event?: Partial<RequestEvent>): RequestContext<Options, State>;
}

export function startPlugin<Options = undefined, State = undefined>(
	server: ServerPlugin<Options, State>,
	{ name = 'test-plugin', options }: { name?: string; options?: Options } = {}
): StartedPlugin<Options, State> {
	const [live] = start_plugins(
		[{ name, options, server: server as ServerPlugin<unknown, unknown> }],
		TEST_SIGNER
	);
	return {
		app: live.app as ServerApp<Options>,
		ctx(request, event = {}) {
			const url = new URL(request.url);
			const full = {
				request,
				url,
				route: { id: null },
				cookies: { get: () => undefined, getAll: () => [] },
				locals: {},
				...event
			} as unknown as RequestEvent;
			const [ctx] = request_contexts(
				[live],
				full,
				url.pathname,
				facts_of(request),
				async () => null
			);
			return ctx as RequestContext<Options, State>;
		}
	};
}
