/**
 * `ogygia/plugin` — the SERVER realm of a plugin (design: internal/notes/packages.md, plugin API v2).
 *
 * A plugin package exports `./server`; its default export is `defineServer({ … })`. The build finds
 * it by the plugin's name and imports it statically into the server bundle. Every hook gets a
 * context scoped to its moment: `app` once per server process (`setup`), `ctx` per request.
 *
 *   export default defineServer<Options, State>({
 *     setup(app) { … },                       // once: app.options, app.notify, app.ask, app.facts()
 *     state: () => ({ … }),                   // fresh per request: ctx.state
 *     async page(ctx) { … },                  // FIRST: a Response answers the page request
 *     async response(ctx, res) { … },         // SEQUENTIAL: a Response replaces the page's
 *     done(ctx) { … },                        // PARALLEL: the request's end, always
 *     invalidate(tags) { … }                  // a SHARED hook: anyone calls app.notify.invalidate()
 *   });
 *
 * First-party only until the ports settle (user ruling, 2026-10-31). Pure helpers that need no
 * context live in `ogygia/plugin/utils`.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestFacts } from './facts.js';
import type { Ask, Notify, ServerHooks } from './hooks.js';
import type { DevtoolsEventInput } from '../devtools/schema.js';

export type { RequestFacts } from './facts.js';
export type { ServerHooks } from './hooks.js';
export type { DevtoolsEventInput } from '../devtools/schema.js';

/** The server process, as one plugin sees it (handed to `setup`, and on every `ctx.app`). */
export interface ServerApp<Options = undefined> {
	/** The plugin's name (its package name). */
	readonly name: string;
	/** The options the app gave the plugin in vite.config (JSON). */
	readonly options: Options;
	/** Call a shared hook on every plugin that has it. */
	readonly notify: Notify;
	/** Ask a shared hook: the first answer that is not `undefined`, in plugin order. */
	readonly ask: Ask;
	/** A request's facts (made on first touch) — for the plugin's own code outside a hook. */
	facts(request: Request): RequestFacts;
	/** The facts of the request the running code belongs to (a load, a render), or null outside one. */
	current(): RequestFacts | null;
	/** Sign `message` with the app's region key (HMAC): a capability only this app can mint. */
	sign(message: string): string;
	/** Check a signature `sign` made (constant-time). */
	verify(message: string, signature: string): boolean;
	/** Record a server-realm event into the current request's devtools stream (a no-op unless
	 *  devtools is on for that browser). */
	devtools(event: DevtoolsEventInput): void;
	/** Warn once per message, prefixed with the plugin's name. */
	warn(message: string): void;
}

/** One request, as one plugin sees it. */
export interface RequestContext<Options = undefined, State = undefined> {
	/** Kit's own event, untouched. */
	readonly event: RequestEvent;
	/** The decoded pathname. */
	readonly path: string;
	/** This plugin's per-request state, from its `state()`. */
	readonly state: State;
	readonly options: Options;
	readonly app: ServerApp<Options>;
	/** The request's shared facts. */
	readonly facts: RequestFacts;
	/** This request's value for a route option (`export const <name>` on a Kit page, or a programmatic
	 *  router's declaration), or `undefined` when nothing declares it. */
	routeOption(name: string): boolean | undefined;
	/** Render one signed hole in place, with this request's event (its cookies ride in): the hole's
	 *  HTML, or null when it cannot render now (the stored fallback stays, the browser fetches). */
	renderHole(endpoint: string): Promise<string | null>;
	/** Name the first reason this render is per-visitor (later reasons do not replace it). */
	perVisitor(reason: string): void;
}

type MaybePromise<T> = T | Promise<T>;

/** A plugin's server half: lifecycle hooks plus any shared hooks it implements. */
export type ServerPlugin<Options = undefined, State = undefined> = Partial<ServerHooks> & {
	/** Once, when the server starts. */
	setup?(app: ServerApp<Options>): void;
	/** Fresh per-request state, handed back on `ctx.state`. */
	state?(): State;
	/** FIRST — every request, before anything else in the handle (above the page / hole split).
	 *  A Response answers it. */
	request?(ctx: RequestContext<Options, State>): MaybePromise<void | Response>;
	/** FIRST — a PAGE request (not a hole, not a page-facts lookup), before Kit renders it. A
	 *  Response answers it (a stored copy). */
	page?(ctx: RequestContext<Options, State>): MaybePromise<void | Response>;
	/** SEQUENTIAL — the page's response, before it streams out. A Response replaces it. */
	response?(ctx: RequestContext<Options, State>, response: Response): MaybePromise<void | Response>;
	/** PARALLEL — the request's end, always (an answered, failed or streamed request included). Must
	 *  not throw; must not await anything slow. */
	done?(ctx: RequestContext<Options, State>): void;
};

/** Typed identity: a plugin's server half. */
export function defineServer<Options = undefined, State = undefined>(
	plugin: ServerPlugin<Options, State>
): ServerPlugin<Options, State> {
	return plugin;
}

/** Stamped into a document served FROM a store (not the render that just happened): the browser
 *  runtime then treats `render: 'live'` lakes as stale on first mount and revalidates them. */
export const STORED_DOCUMENT_META = '<meta name="ogygia-freeze" content="hit">';

// ── region values a plugin's server code makes
/** A region value holding finished HTML (rendered as-is, no island); and `region(Component, props)`
 *  itself (the same as `ogygia`'s, without loading the whole front door). */
export { og_html_region as htmlRegion, region } from '../region.js';

import { REGION_BRAND } from '../region-brand.js';
import type { DeferredRegion } from '../region.js';

/** A deferred region value whose HTML the browser fetches from `url` (a capability the plugin minted,
 *  `''` for an inert one). HTML only: whatever islands the answer carries wake themselves. */
export function deferredRegion(id: string, url: string): DeferredRegion {
	return { [REGION_BRAND]: true, kind: 'deferred', id, props: {}, url, module: '' };
}
