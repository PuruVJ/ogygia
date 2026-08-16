/**
 * Build a signed region capability URL (same shape as server-island holes).
 * Used by Region's lake branch for `render: 'live'`. Client build gets a stub that returns ''.
 */
import { secret, secretStable } from 'virtual:ogygia/secret';
import { sessionCookie } from 'virtual:ogygia/session-cookie';
import { regionTtl } from 'virtual:ogygia/region-ttl';
import { sign, region_mac_message } from 'virtual:ogygia/sign';
import { resolve } from '$app/paths';
import { building } from '$app/environment';
import { getRequestEvent } from 'virtual:ogygia/request-event';
import {
	DEFAULT_ISLANDS_ENDPOINT,
	MAX_REGION_PROPS_LEN,
	PRERENDER_REGION_TTL_SEC
} from './endpoint.js';
import { encode_region_props } from './region-props.js';
import { stringify } from 'devalue';
import { B64Url } from './payload.js';
import { TRANSPORT_WIRE_KEY, reduce_transportable } from '../live-transport.js';
import { REGION_SNIPPET_WIRE_KEY, reduce_region_snippet } from '../region-snippet.js';

/** Session sealed into the MAC when `ogygia({ sessionCookie })` is set; empty at prerender. */
function region_session(): string {
	if (!sessionCookie) return '';
	try {
		return getRequestEvent().cookies.get(sessionCookie) ?? '';
	} catch {
		return '';
	}
}

/**
 * One warning per build (shared Symbol key → one message total across every mint path): a
 * prerendered hole signed with the per-build random key dies on the NEXT deploy (new key, old
 * static file). Real PPR needs a stable OGYGIA_SECRET.
 */
function warn_unstable_secret(): void {
	if (!building || secretStable) return;
	const g = globalThis as Record<symbol, unknown>;
	const K = Symbol.for('ogygia.prerender-secret-warned');
	if (g[K]) return;
	g[K] = true;
	console.warn(
		'[ogygia] prerendered page mints region capabilities signed with a per-build random key — they stop verifying after your next deploy while the static HTML lives on. Set a stable OGYGIA_SECRET env var so prerendered holes survive redeploys.'
	);
}

/**
 * Shared minting core for signed region capabilities — the ONE source of truth for the
 * `/🏝️?id&props&exp&sig` URL, its MAC message, TTL policy, and session sealing. Both held regions
 * (via {@link makeRegionEndpoint}) and server islands (Region.svelte's server branch) sign through this,
 * each deriving/validating its own `payload` first (held regions degrade to `''` on failure, server
 * islands throw). Given a valid encoded `payload`, the emitted URL/MAC/exp is identical to both.
 *
 * @param entry region id (server-manifest key baked into the MAC)
 * @param payload b64url props blob (already encoded + size-checked by the caller)
 * @param ttl response cache max-age in **seconds** (`0` = no-store, the default). Signed into the MAC
 *   and echoed as a `ttl` query param so the handle sets `Cache-Control` from it — a harvested URL
 *   can't be re-pointed at a longer browser cache.
 */
export function mint_region_capability(entry: string, payload: string, ttl = 0): string {
	const session = region_session();
	// Prerendered (real PPR): the capability lives in a static file that outlives any TTL — mint it
	// effectively-forever (props are public in the HTML; session sealed empty). Dynamic pages keep
	// the short `regionTtl` window so harvested URLs age out.
	const exp = Math.floor(Date.now() / 1000) + (building ? PRERENDER_REGION_TTL_SEC : regionTtl);
	warn_unstable_secret();
	// A hole is dynamic by default (`ttl` 0 → the handle answers `no-store`); a positive `ttl` opts
	// into a `private, max-age=ttl` browser cache. Empty string when 0 keeps the MAC field stable.
	const ttl_field = ttl > 0 ? String(Math.floor(ttl)) : '';
	const sig = sign(secret, region_mac_message(entry, exp, payload, session, ttl_field));
	const ttl_param = ttl_field ? `&ttl=${ttl_field}` : '';
	return `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(entry)}&props=${payload}&exp=${exp}${ttl_param}&sig=${sig}`;
}

/**
 * Server-island mint: encode `props` (devalue + wire codec), enforce the size cap (THROW — a server
 * island with oversized/non-serializable props is an author bug the handle would reject anyway), and
 * sign. The one place `Region.svelte`'s `__mode: 'server'` branch signs its hole; routed through the
 * `virtual:ogygia/region-endpoint` virtual so the client build stubs it to `''` (server islands never
 * mint on the client — the runtime fetches the endpoint). Mirrors the old `ServerIsland.svelte`.
 */
export function mintServerIsland(entry: string, props: Record<string, unknown>, ttl = 0): string {
	const payload = B64Url.encode(
		stringify(props, {
			[TRANSPORT_WIRE_KEY]: reduce_transportable,
			[REGION_SNIPPET_WIRE_KEY]: reduce_region_snippet
		})
	);
	if (payload.length > MAX_REGION_PROPS_LEN) {
		throw new Error(
			`[ogygia] server island "${entry}": props payload is ${payload.length} b64 chars (max ${MAX_REGION_PROPS_LEN}). ` +
				`Shrink what you pass into the deferred region — the handle would reject this capability anyway.`
		);
	}
	return mint_region_capability(entry, payload, ttl);
}

/** HMAC-signed `/🏝️?id&props&exp&sig` for re-rendering `entry` with `props`. */
export function makeRegionEndpoint(entry: string, props: Record<string, unknown> = {}): string {
	const payload = encode_region_props(props);
	if (payload == null) {
		// Non-serializable or oversized props. Degrading to "no endpoint" makes the region behave
		// like a static lake; throwing would 500 the PAGE. The handle would 403 the same blob.
		console.warn(
			`[ogygia] render:'live' region ${entry} has props that cannot cross the wire (non-serializable or >${MAX_REGION_PROPS_LEN} b64 chars) — no revalidate endpoint minted (behaves like a static lake).`
		);
		return '';
	}
	return mint_region_capability(entry, payload);
}

export { encode_region_props } from './region-props.js';
