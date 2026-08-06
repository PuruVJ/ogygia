/**
 * Build a signed region capability URL (same shape as server-island holes).
 * Used by LakeRegion for `remount: 'swr'`. Client build gets a stub that returns ''.
 */
import { secret } from 'virtual:ogygia/secret';
import { sessionCookie } from 'virtual:ogygia/session-cookie';
import { regionTtl } from 'virtual:ogygia/region-ttl';
import { sign, region_mac_message } from 'virtual:ogygia/sign';
import { resolve } from '$app/paths';
import { getRequestEvent } from 'virtual:ogygia/request-event';
import { DEFAULT_ISLANDS_ENDPOINT, MAX_REGION_PROPS_LEN } from './endpoint.js';
import { encode_region_props } from './region-props.js';

function region_session(): string {
	if (!sessionCookie) return '';
	try {
		return getRequestEvent().cookies.get(sessionCookie) ?? '';
	} catch {
		return '';
	}
}

/** HMAC-signed `/🏝️ogygia🏝️?id&props&exp&sig` for re-rendering `entry` with `props`. */
export function makeRegionEndpoint(entry: string, props: Record<string, unknown> = {}): string {
	const payload = encode_region_props(props);
	if (payload == null) {
		// Non-serializable or oversized props. Degrading to "no endpoint" makes the region behave
		// like `remount: 'cache'`; throwing would 500 the PAGE. The handle would 403 the same blob.
		console.warn(
			`[ogygia] remount:'swr' region ${entry} has props that cannot cross the wire (non-serializable or >${MAX_REGION_PROPS_LEN} b64 chars) — no revalidate endpoint minted (behaves like remount:'cache').`
		);
		return '';
	}
	const session = region_session();
	const exp = Math.floor(Date.now() / 1000) + regionTtl;
	const sig = sign(secret, region_mac_message(entry, exp, payload, session));
	return `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(entry)}&props=${payload}&exp=${exp}&sig=${sig}`;
}

export { encode_region_props } from './region-props.js';
