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
	setHeaders?: RequestEvent['setHeaders'];
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
	routeId: string
): Ctx {
	const search: Record<string, string> = {};
	for (const [k, v] of url.searchParams) if (!(k in search)) search[k] = v;
	return {
		params,
		search,
		input: undefined,
		url,
		request,
		route: { id: routeId },
		fetch: event?.fetch ?? fetch,
		cookies: event?.cookies,
		locals: event?.locals,
		setHeaders: event?.setHeaders,
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
	} as Ctx;
}
