/**
 * Core's side of the server realm: turns the generated plugin list into live plugins (an `app` each,
 * `setup` called once, shared hooks registered) and makes each request's per-plugin contexts. Used
 * by hooks.ts only.
 */
import type { Handle, RequestEvent } from '@sveltejs/kit';
import type { RequestContext, ResolveOptions, ServerApp, ServerPlugin } from './index.ts';
import { current_facts, facts_of, mark_per_visitor, type RequestFacts } from './facts.ts';
import { ask, notify, register_hooks } from './hooks.ts';
import { route_option } from './routes.ts';
import { record_server_event } from '../events/server-registry.ts';

/** One plugin's server half as the build lists it (`virtual:ogygia/server-plugins`). */
export interface ServerPluginEntry {
	name: string;
	options: unknown;
	server: ServerPlugin<unknown, unknown>;
}

/** A live plugin: its definition and its app. */
export interface LivePlugin {
	def: ServerPlugin<unknown, unknown>;
	app: ServerApp<unknown>;
}

/** The app's signer, handed in by the handle (it holds the region key). */
export interface AppSigner {
	sign(message: string): string;
	verify(message: string, signature: string): boolean;
}

/** Make each plugin live, in order: app, shared hooks, `setup`. */
export function start_plugins(
	entries: readonly ServerPluginEntry[],
	signer: AppSigner
): LivePlugin[] {
	return entries.map(({ name, options, server }) => {
		const warned = new Set<string>();
		const app: ServerApp<unknown> = {
			name,
			options,
			notify,
			ask,
			facts: facts_of,
			current: current_facts,
			sign: signer.sign,
			verify: signer.verify,
			devtools: record_server_event,
			warn(message) {
				if (warned.has(message)) return;
				warned.add(message);
				console.warn(`[${name}] ${message}`);
			}
		};
		register_hooks(server);
		server.setup?.(app);
		return { def: server, app };
	});
}

/** Two `resolve()` option sets as one: the inner transform (ogygia's document injection) runs first,
 *  the outer (a plugin's `handle`) sees the finished chunk; the other options merge, outer last. */
export function compose_resolve_options(
	inner?: ResolveOptions,
	outer?: ResolveOptions
): ResolveOptions | undefined {
	if (!inner) return outer;
	if (!outer) return inner;
	const a = inner.transformPageChunk;
	const b = outer.transformPageChunk;
	return {
		...inner,
		...outer,
		transformPageChunk: !a
			? b
			: !b
				? a
				: async (input) => {
						const first = await a(input);
						if (first === undefined) return first;
						return b({ ...input, html: first });
					}
	};
}

/** The plugins' `handle` hooks nested around `core`, first plugin outermost. No hook: `core` itself. */
export function around(plugins: readonly LivePlugin[], core: Handle): Handle {
	let inner = core;
	for (let i = plugins.length - 1; i >= 0; i--) {
		const { def, app } = plugins[i];
		const handle = def.handle;
		if (!handle) continue;
		const next_handle = inner;
		inner = async ({ event, resolve }) =>
			handle({ event, options: app.options, app }, (outer) =>
				Promise.resolve(
					next_handle({
						event,
						resolve: (ev, opts) => resolve(ev, compose_resolve_options(opts, outer))
					})
				)
			);
	}
	return inner;
}

/** The per-plugin contexts of one request. */
export function request_contexts(
	plugins: readonly LivePlugin[],
	event: RequestEvent,
	path: string,
	facts: RequestFacts,
	render_hole: (endpoint: string) => Promise<string | null>
): RequestContext<unknown, unknown>[] {
	const route_id = event.route?.id;
	const route_opt = (name: string) => route_option(name, route_id, path);
	const per_visitor = (reason: string) => mark_per_visitor(facts, reason);
	return plugins.map(({ def, app }) => ({
		event,
		path,
		state: def.state?.(),
		options: app.options,
		app,
		facts,
		routeOption: route_opt,
		renderHole: render_hole,
		perVisitor: per_visitor
	}));
}
