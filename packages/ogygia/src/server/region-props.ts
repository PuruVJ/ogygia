/**
 * Encode region capability props (devalue → b64url) with the same size bound the handle enforces.
 * No virtual imports — safe to unit-test and share between mint paths.
 */
import { stringify } from 'devalue';
import { B64Url } from './payload.js';
import { MAX_REGION_PROPS_LEN } from './endpoint.js';
import { TRANSPORT_WIRE_KEY, reduce_transportable } from '../live-transport.js';
import { REGION_SNIPPET_WIRE_KEY, reduce_region_snippet } from '../region-snippet.js';

/**
 * @returns b64url payload, or null when props cannot cross the wire (non-devalue or oversized).
 */
export function encode_region_props(props: Record<string, unknown>): string | null {
	let payload: string;
	try {
		payload = B64Url.encode(
			stringify(props, {
				[TRANSPORT_WIRE_KEY]: reduce_transportable,
				[REGION_SNIPPET_WIRE_KEY]: reduce_region_snippet
			})
		);
	} catch {
		return null;
	}
	if (payload.length > MAX_REGION_PROPS_LEN) return null;
	return payload;
}
