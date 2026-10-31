/**
 * Capability virtual-module emitters — the leg-split sources for the signed-capability family:
 * `virtual:ogygia/secret`, `/sign`, `/rate-limit`, `/session-cookie`, `/region-ttl`. Each is a pure
 * `(ssr, <one resolved config value>) => string`: the SSR leg carries the real signer / baked config,
 * the client leg gets an inert stub (a browser never mints). The driver's `emit` dispatch calls these.
 */

import {
	csrTrueRouteIds,
	errorCsrTrueRouteIds,
	page_route_options,
	rootLayoutCsrTrue
} from '../kit.ts';

/**
 * `virtual:ogygia/secret` — SERVER only: the per-build random key material and whether the BUILD
 * saw an `OGYGIA_SECRET` (its region ids are salted from it). CLIENT build: empty (never mint in the
 * browser). Which key signs is decided at first use, not here (server/signing-key.ts): the runtime's
 * `OGYGIA_SECRET` when the host sets it — read then, so an env a host fills after module eval still
 * counts — else this build's key.
 */
export function secret_module(
	ssr: boolean,
	build_secret: string,
	build_had_secret: boolean
): string {
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
			`export function region_mac_message(id, exp, props, session = '', ttl = '', render = '') {\n` +
			`  const enc = new TextEncoder();\n` +
			`  const lp = (s) => enc.encode(String(s)).byteLength + ':' + String(s);\n` +
			`  const v1 = lp(id) + '|' + lp(exp) + '|' + lp(props) + '|' + lp(session) + '|' + lp(ttl);\n` +
			`  return render === '' ? 'v1|' + v1 : 'v2|' + v1 + '|' + lp(render);\n` +
			`}\n`
		);
	}
	return `export { sign, verify, region_mac_message } from ${JSON.stringify(hmac_module)};`;
}

/**
 * `virtual:ogygia/server-plugins` — SERVER only: each plugin's server half, one static import per
 * plugin, in the order the app listed them. The handle runs their stages straight off this list; an
 * app with no plugins gets an empty one (and the client always does).
 */
/** One plugin's server realm, as the build wires it. */
export interface ServerRealm {
	/** the plugin's (package) name */
	name: string;
	/** the realm module's absolute POSIX path (the plugin's `server`) */
	module: string;
	/** the plugin's options (JSON) */
	options: unknown;
}

export function server_plugins_module(ssr: boolean, realms: readonly ServerRealm[]): string {
	if (!ssr || realms.length === 0) return `export const plugins = [];`;
	const imports = realms.map((r, i) => `import p${i} from ${JSON.stringify(r.module)};`).join('\n');
	const list = realms
		.map(
			(r, i) =>
				`{ name: ${JSON.stringify(r.name)}, options: ${JSON.stringify(r.options)}, server: p${i} }`
		)
		.join(',\n\t');
	return `${imports}\nexport const plugins = [\n\t${list}\n];`;
}

/** `virtual:ogygia/route-options` — SERVER only: every Kit page route id → the plugin route options
 *  it declares (`export const <name>`, cascaded like csr; undeclared options absent). Empty on the
 *  client, and when no plugin declares an option: the route list never ships to the browser. */
export function route_options_module(
	ssr: boolean,
	routesDir: string,
	names: readonly string[]
): string {
	if (!ssr || names.length === 0) return `export const route_options = {};`;
	return `export const route_options = ${JSON.stringify(page_route_options(routesDir, names))};`;
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

/** `virtual:ogygia/region-ttl` — SERVER only; the capability expiry window for mint, and how long
 *  after expiry an anonymous capability still renews. */
export function region_ttl_module(ssr: boolean, region_ttl: number, renew_window: number): string {
	if (!ssr) return `export const regionTtl = 3600;\nexport const renewWindow = 0;`;
	return `export const regionTtl = ${region_ttl};\nexport const renewWindow = ${renew_window};`;
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
