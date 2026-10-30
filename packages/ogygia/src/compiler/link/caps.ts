/**
 * Capability virtual-module emitters — the leg-split sources for the signed-capability family:
 * `virtual:ogygia/secret`, `/sign`, `/rate-limit`, `/session-cookie`, `/region-ttl`. Each is a pure
 * `(ssr, <one resolved config value>) => string`: the SSR leg carries the real signer / baked config,
 * the client leg gets an inert stub (a browser never mints). The driver's `emit` dispatch calls these.
 */

import {
	csrTrueRouteIds,
	errorCsrTrueRouteIds,
	freezeRouteIds,
	pageRouteIds,
	rootLayoutCsrTrue
} from '../kit.js';

/**
 * `virtual:ogygia/secret` — SERVER only: the per-build random key material and whether the BUILD
 * saw an `OGYGIA_SECRET` (its region ids are salted from it). CLIENT build: empty (never mint in the
 * browser). Which key signs is decided at first use, not here (server/signing-key.ts): the runtime's
 * `OGYGIA_SECRET` when the host sets it — read then, so an env a host fills after module eval still
 * counts — else this build's key.
 */
export function secret_module(ssr: boolean, build_secret: string, build_had_secret: boolean): string {
	if (!ssr) return `export const buildKey = '';\nexport const buildHadSecret = false;`;
	return `export const buildKey = ${JSON.stringify(build_secret)};\nexport const buildHadSecret = ${build_had_secret};`;
}

/**
 * `virtual:ogygia/sign` — same split as secret: SSR mints with node:crypto (re-exports the real
 * HMAC module); client never mints (secret is ''), but still needs `region_mac_message` for the
 * length-prefixed canonical form the runtime compares against.
 */
export function sign_module(ssr: boolean, hmac_module: string): string {
	if (!ssr) {
		return (
			`export function sign(_secret, _message) { return ''; }\n` +
			`export function verify(_secret, _message, _sig) { return false; }\n` +
			`export function region_mac_message(id, exp, props, session = '', ttl = '') {\n` +
			`  const enc = new TextEncoder();\n` +
			`  const lp = (s) => enc.encode(String(s)).byteLength + ':' + String(s);\n` +
			`  return 'v1|' + lp(id) + '|' + lp(exp) + '|' + lp(props) + '|' + lp(session) + '|' + lp(ttl);\n` +
			`}\n`
		);
	}
	return `export { sign, verify, region_mac_message } from ${JSON.stringify(hmac_module)};`;
}

/**
 * `virtual:ogygia/profiler-config` — SERVER only: the profiler options from `ogygia({ profiler })`,
 * or `null` when unset. `ogygia.handle()` reads it and, when non-null, dynamically imports and mounts
 * the profiler — so hooks.server.ts never mentions it and the profiler's weight loads only when
 * enabled. The SECRET is here only when the author passes `profiler.secret`: then it IS baked into the
 * server bundle (on purpose — a serverless host such as Amplify has no runtime env to read it from), so
 * treat that bundle as holding it. Left out, the profiler reads OGYGIA_PROFILER_SECRET at runtime and
 * nothing is baked. Never in a client bundle or a frozen page.
 */
export function profiler_config_module(
	ssr: boolean,
	profiler_config: Record<string, unknown> | null
): string {
	if (!ssr) return `export const profilerConfig = null;`;
	return `export const profilerConfig = ${JSON.stringify(profiler_config)};`;
}

/**
 * `virtual:ogygia/freeze-config` — SERVER only: the freeze policy from `ogygia({ freeze })`,
 * or `null` when off. Non-null turns the handle's freeze read/write path on (the switch +
 * serializable policy; live store/edge adapters enter via `freeze.configure()` in hooks).
 */
export function freeze_config_module(ssr: boolean, freeze_config: { ttl: number } | null): string {
	if (!ssr) return `export const freezeConfig = null;`;
	return `export const freezeConfig = ${JSON.stringify(freeze_config)};`;
}

/** `virtual:ogygia/rate-limit` — SERVER only; the region handle is the only consumer. */
export function rate_limit_module(
	ssr: boolean,
	rate_limit: { max: number; windowMs: number }
): string {
	if (!ssr) return `export const rateLimit = { max: 0, windowMs: 60000 };`;
	return `export const rateLimit = ${JSON.stringify(rate_limit)};`;
}

/** `virtual:ogygia/session-cookie` — SERVER only; sealed into the region MAC when non-empty. */
export function session_cookie_module(ssr: boolean, session_cookie: string): string {
	if (!ssr) return `export const sessionCookie = '';`;
	return `export const sessionCookie = ${JSON.stringify(session_cookie)};`;
}

/** `virtual:ogygia/region-ttl` — SERVER only; the capability expiry window for mint. */
export function region_ttl_module(ssr: boolean, region_ttl: number): string {
	if (!ssr) return `export const regionTtl = 3600;`;
	return `export const regionTtl = ${region_ttl};`;
}

/** `virtual:ogygia/route-csr` — SERVER only: the csr=true route ids, so a csr=false layout's islands
 *  degrade to inline when the LEAF page is csr=true (Kit hydrates the whole document). The CLIENT leg
 *  is an empty set — the client reads the identical signal from `kit_hydrates_page()`, and the route
 *  list never ships to the browser. */
export function route_csr_module(ssr: boolean, routesDir: string): string {
	if (!ssr)
		return (
			`export const csr_true_routes = new Set();\n` +
			`export const error_csr_true_routes = new Set();\n` +
			`export const root_layout_csr_true = true;`
		);
	// The error-render map beside the page map: Kit renders a route's error page with its LAYOUT
	// branch only, so a 404 under a csr=false page is hydrated whenever the layouts say so.
	return (
		`export const csr_true_routes = new Set(${JSON.stringify(csrTrueRouteIds(routesDir))});\n` +
		`export const error_csr_true_routes = new Set(${JSON.stringify(errorCsrTrueRouteIds(routesDir))});\n` +
		`export const root_layout_csr_true = ${rootLayoutCsrTrue(routesDir)};`
	);
}

/** `virtual:ogygia/freeze-routes` — SERVER only: the route ids whose effective `export const
 *  freeze` opt-in is true, given the config `default`. The handle stores/serves a page only when
 *  its route is in this set (then the observed-purity check still decides eligibility). Empty on the
 *  client — the route list never ships to the browser. */
export function freeze_routes_module(ssr: boolean, routesDir: string, defaultOn: boolean): string {
	if (!ssr)
		return `export const freeze_routes = new Set();\nexport const freeze_pages = new Set();`;
	return (
		`export const freeze_routes = new Set(${JSON.stringify(freezeRouteIds(routesDir, defaultOn))});\n` +
		`export const freeze_pages = new Set(${JSON.stringify(pageRouteIds(routesDir))});`
	);
}
