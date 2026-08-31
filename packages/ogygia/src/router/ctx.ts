/**
 * The `ctx` a load / action / handler receives — the router's whole request surface. Web-standard at
 * the seam (`request`, `url`, `cookies`, `fetch`), plus Kit RequestEvent pass-throughs (present when
 * mounted in Kit) and response shortcuts. Sequencing/sharing between loads is `await other_load(c)`;
 * control flow is the throwable `redirect()`/`error()` from respond.ts (NOT ctx methods — that keeps
 * loads/handlers Kit-shaped). `c.params` is typed from the route pattern.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { Simplify } from './view.js';
import { json_response, redirect_response } from './respond.js';

/** The visitor's identity — plain claims (`sub`, roles, whatever the app's session carries). */
export type Visitor = Record<string, unknown> & { sub?: string };

/** Signature-bound claims attached by `expose()` after verification (fragment federation). */
const CLAIMS = Symbol.for('ogygia.claims.v1');

export interface Ctx<
	P = Record<string, string | undefined>,
	S = Record<string, string>,
	I = undefined
> {
	/** Path params — pattern-typed, or the `params` schema's coerced output (404 on bad input). */
	params: Simplify<P>;
	/** Query params — raw `{ [k]: string }`, or the `search` schema's typed output (400 on bad input). */
	search: Simplify<S>;
	/** A body-verb endpoint's validated JSON body (`POST`/`PUT`/`PATCH` schema); else `undefined`. */
	input: I;
	url: URL;
	request: Request;
	/** The matched route pattern, e.g. `/docs/[slug]` (Kit's `route.id`). */
	route: { id: string };
	// Kit RequestEvent pass-throughs — present when mounted in Kit (handle / catchall). `fetch` always
	// works (Kit's cookie-forwarding fetch in Kit, global fetch standalone); the rest are undefined off-Kit.
	fetch: typeof fetch;
	cookies?: RequestEvent['cookies'];
	locals?: RequestEvent['locals'];
	/** Set response headers from a load/action/handler. ALWAYS works: the router applies these to
	 *  the Response IT builds — Kit's own `event.setHeaders` only affects `resolve()`-built
	 *  responses, and a router-rendered document bypasses resolve (found when a mount load's
	 *  Server-Timing silently vanished). */
	setHeaders?: RequestEvent['setHeaders'];
	/** @internal headers collected via setHeaders — the dispatcher merges them onto the response. */
	collected_headers?: Map<string, string>;
	/** WHO is this request? THE identity — derived ONCE. Precedence: signature-bound claims from
	 *  an upstream shell (fragment federation — unforgeable, they arrived inside an Ed25519
	 *  signature) → the table's `visitor` resolver (`routes(table, { visitor })`) → undefined.
	 *  Everything downstream READS this instead of re-deriving: experiments stick on it, mounts
	 *  sign it onward, loads personalize with it. */
	readonly visitor?: Visitor;
	platform?: Readonly<RequestEvent['platform']>;
	getClientAddress?: RequestEvent['getClientAddress'];
	/** The raw Kit event, when mounted in Kit. */
	event?: RequestEvent;
	/** JSON response (default application/json, no-store). */
	json(data: unknown, init?: ResponseInit): Response;
	/** Redirect Response (default 303). Prefer the throwable `redirect()` inside loads/actions. */
	redirect(location: string, status?: number): Response;
	/** Plain-text response. */
	text(body: string, init?: ResponseInit): Response;
	/** A rename-safe URL to a route in this router: `c.href('/report/[id]', { id })`. */
	href(pattern: string, params?: Record<string, string | number>): string;
	/** A per-request scratch bag (a guard writes, a handler reads). */
	state: Record<string, unknown>;
}

export function make_ctx(
	params: Record<string, string | undefined>,
	url: URL,
	request: Request,
	event: RequestEvent | undefined,
	href: (pattern: string, params?: Record<string, string | number>) => string,
	routeId: string,
	visitor_resolver?: (c: Ctx) => Visitor | undefined
): Ctx {
	const search: Record<string, string> = {};
	for (const [k, v] of url.searchParams) if (!(k in search)) search[k] = v;
	const collected_headers = new Map<string, string>();
	// lazy, memoized identity — endpoints that never ask never pay
	let visitor_memo: Visitor | undefined;
	let visitor_resolved = false;
	const ctx: Ctx = {
		collected_headers,
		get visitor(): Visitor | undefined {
			if (!visitor_resolved) {
				visitor_resolved = true;
				// signature-bound claims from an upstream shell win (they are PROOF, not config)
				const claims = (request as unknown as Record<symbol, Visitor | undefined>)[CLAIMS];
				visitor_memo = claims ?? visitor_resolver?.(ctx);
			}
			return visitor_memo;
		},
		params,
		search,
		input: undefined,
		url,
		request,
		route: { id: routeId },
		fetch: event?.fetch ?? fetch,
		cookies: event?.cookies,
		locals: event?.locals,
		setHeaders: (headers) => {
			for (const [k, v] of Object.entries(headers)) collected_headers.set(k.toLowerCase(), v);
			event?.setHeaders?.(headers); // still forward to Kit for resolve()-built responses
		},
		platform: event?.platform,
		getClientAddress: event?.getClientAddress,
		event,
		json: (data, init) => json_response(data, init),
		redirect: (location, status = 303) => redirect_response(status, location),
		text: (body, init) =>
			new Response(body, {
				...init,
				headers: { 'content-type': 'text/plain; charset=utf-8', ...init?.headers }
			}),
		href,
		state: {}
	};
	return ctx;
}
