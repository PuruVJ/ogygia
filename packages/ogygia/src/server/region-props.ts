/**
 * Encode region capability props (devalue → b64url) with the same size bound the handle enforces.
 * No virtual imports — safe to unit-test and share between mint paths.
 */
import { stringify } from 'devalue';
import { B64Url } from './payload.js';
import { MAX_REGION_PROPS_LEN } from './endpoint.js';
import { REF_WIRE_KEY, ref_reducer } from '../ref.js';
// PULL-registration inside the function below (idempotent; no import-time side effects).
import { register_wire_kind } from '../live-transport.js';
import { register_store_kind } from '../store-transport.js';
import { register_snippet_kind } from '../region-snippet.js';
import { register_fn_kind } from '../fn-transport.js';
import { register_derived_kind } from '../store-transport.js';

/** Ensure the island-prop kinds are registered (called per encode; Map.has-cheap). */
export function ensure_prop_kinds(): void {
	register_wire_kind();
	register_store_kind();
	register_snippet_kind();
	register_fn_kind();
	register_derived_kind();
}

/** Island props carry classes, stores, snippets, og.$ fns and resumable deriveds. */
const PROP_FAMILIES = new Set(['wire', 'store', 'snippet', 'fn', 'derived']);

/**
 * @returns b64url payload, or null when props cannot cross the wire (non-devalue or oversized).
 */
export function encode_region_props(props: Record<string, unknown>): string | null {
	ensure_prop_kinds();
	let payload: string;
	try {
		payload = B64Url.encode(stringify(props, { [REF_WIRE_KEY]: ref_reducer(PROP_FAMILIES) }));
	} catch {
		return null;
	}
	if (payload.length > MAX_REGION_PROPS_LEN) return null;
	return payload;
}
