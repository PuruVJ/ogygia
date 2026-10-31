/**
 * THE PLUGIN DOOR — the one module a first-party plugin (flags, freeze, federation, content,
 * profiler, devtools, the server router) may import from core. Plugins never reach core files by
 * path: they get PORTS (small typed objects handed to them at fixed hook points) and the few
 * helpers below. Design: internal/notes/packages.md.
 *
 * First-party only until the ports settle (user ruling, 2026-10-31): no stability promise to
 * outside authors yet.
 *
 * An app names its plugins once, in the Vite config — `ogygia({ plugins: [flags()] })`. The build
 * turns the list into generated static imports (`virtual:ogygia/server-plugins`), so a request
 * never looks a plugin up by name and an app without plugins carries none of this.
 */
import type { RequestEvent } from '@sveltejs/kit';

/** The contract version. A plugin declares the one it was written against; the Vite plugin refuses
 *  a mismatch at config time (first-party plugins release in lockstep with core). */
export const PLUGIN_API = 1;

/** What an app puts in `ogygia({ plugins })` — the value a plugin's `/vite` factory returns. Plain
 *  data: the build reads it in node; nothing here reaches a browser or a request. */
export interface OgygiaPlugin {
	/** Unique per app (`'flags'`). Names this plugin in errors. */
	name: string;
	/** The `PLUGIN_API` this plugin was written against. */
	api: number;
	/** Module id of the plugin's SERVER half — its default export is a `ServerPlugin`. The build
	 *  imports it statically into the server bundle (`'@ogygia/flags/server'`). */
	server?: string;
}

/** Per request, per plugin: the port a stage receives. */
export interface Req<Bag = undefined> {
	/** Kit's own event, untouched. */
	event: RequestEvent;
	/** THIS plugin's per-request state, from its `bag()` (undefined without one). */
	bag: Bag;
}

/** A plugin's server half. Every stage is optional; core calls them in plugin order. */
export interface ServerPlugin<Bag = undefined> {
	/** Fresh per-request state, handed back on `req.bag`. */
	bag?(): Bag;
	/** Before anything else in the handle (above the page / hole-endpoint split): every request,
	 *  page or hole, sees what ran here. Return a Response to answer the request yourself. */
	request?(req: Req<Bag>): void | Response | Promise<void | Response>;
	/** The request's end, always (finally): an answered, failed or streamed request included. Must
	 *  not throw; must not await anything slow. */
	done?(req: Req<Bag>): void;
}

/** Typed identity helpers — they only exist so a plugin gets inference without restating types. */
export function definePlugin(plugin: OgygiaPlugin): OgygiaPlugin {
	return plugin;
}
export function defineServer<Bag = undefined>(server: ServerPlugin<Bag>): ServerPlugin<Bag> {
	return server;
}

// ── facts (internal/notes/packages.md: shared request facts)
export { personal_read as personalRead, note_assignment as noteAssignment, assignments } from './facts.js';

// ── kernels: small pure helpers several plugins need
/** Sticky 32-bit FNV-1a — uniform and deterministic, not cryptographic. */
export { fnv1a32 } from '../runtime/hash.js';
/** The Standard Schema interface (standardschema.dev): validate a value with any schema library. */
export type { StandardSchemaV1 } from '../router/view.js';
