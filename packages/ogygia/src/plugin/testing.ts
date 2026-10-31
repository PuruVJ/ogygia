/**
 * `ogygia/plugin/testing` — start a plugin's server realm without a server, for unit tests: its app
 * made, its shared hooks registered, its `setup` run (exactly what the handle does at boot), and a
 * request context to call its hooks with.
 *
 *   const { app, ctx } = startPlugin(server, { name: '@ogygia/flags' });
 *   await server.request?.(ctx(new Request('http://x/')));
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestContext, ServerApp, ServerPlugin } from './index.js';
import { facts_of } from './facts.js';
import { request_contexts, start_plugins } from './server.js';

export interface StartedPlugin<Options, State> {
	app: ServerApp<Options>;
	/** A request context for `request` (a bare event: url, request, cookies that read nothing). */
	ctx(request: Request, event?: Partial<RequestEvent>): RequestContext<Options, State>;
}

export function startPlugin<Options = undefined, State = undefined>(
	server: ServerPlugin<Options, State>,
	{ name = 'test-plugin', options }: { name?: string; options?: Options } = {}
): StartedPlugin<Options, State> {
	const [live] = start_plugins([{ name, options, server: server as ServerPlugin<unknown, unknown> }]);
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
			const [ctx] = request_contexts([live], full, url.pathname, facts_of(request), async () => null);
			return ctx as RequestContext<Options, State>;
		}
	};
}
