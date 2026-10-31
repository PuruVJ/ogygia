/**
 * Core's side of the server realm: turns the generated plugin list into live plugins (an `app` each,
 * `setup` called once, shared hooks registered) and makes each request's per-plugin contexts. Used
 * by hooks.ts only.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestContext, ServerApp, ServerPlugin } from './index.js';
import { facts_of, mark_per_visitor, type RequestFacts } from './facts.js';
import { ask, notify, register_hooks } from './hooks.js';
import { route_option } from './routes.js';
import { record_server_event } from '../devtools/server-registry.js';

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

/** Make each plugin live, in order: app, shared hooks, `setup`. */
export function start_plugins(entries: readonly ServerPluginEntry[]): LivePlugin[] {
	return entries.map(({ name, options, server }) => {
		const warned = new Set<string>();
		const app: ServerApp<unknown> = {
			name,
			options,
			notify,
			ask,
			facts: facts_of,
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
