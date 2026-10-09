/**
 * THE WIRE FORMAT of a side-channel script, read back. The server emits two lanes
 * (server/props-wire.ts): plain JSON under `data-og-format="json"` (a payload with nothing devalue
 * exists for — the common CMS props and seed), and devalue otherwise. This is the ONE place the
 * client tells them apart: every seed / props / remote read goes through `parse_wire_text`.
 *
 * Pure (no DOM types beyond an attribute read) so the runtime, the shims and the tests share it.
 */
import { parse } from 'devalue';

export const WIRE_FORMAT_ATTR = 'data-og-format';
export const WIRE_FORMAT_JSON = 'json';

/** Is this side-channel element's text the JSON lane? */
export function wire_is_json(el: Element): boolean {
	return el.getAttribute(WIRE_FORMAT_ATTR) === WIRE_FORMAT_JSON;
}

/** Parse a side-channel's text in its lane: `JSON.parse` for the JSON lane (nothing to revive by
 *  construction), devalue `parse` with the caller's revivers otherwise. */
export function parse_wire_text(
	text: string,
	json: boolean,
	// each reviver names its own payload type; devalue takes them as `(value: any) => any`
	revivers?: Record<string, (value: never) => unknown>
): unknown {
	return json ? JSON.parse(text) : parse(text, revivers as Parameters<typeof parse>[1]);
}
