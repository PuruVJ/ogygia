/**
 * Streaming server islands (no extra round-trip): the `handle()` body-stream wrapper scans the page
 * HTML for immediate deferred holes and, for each, renders the island in-process and appends its HTML
 * as a `<template data-ogygia-slot>` parcel AFTER the document. The browser's parser appends anything
 * past `</html>` to `<body>`; `<template>` content is inert (no paint, no scripts, no image loads), so
 * it is a safe parcel the runtime moves into the matching region.
 *
 * This module is the PURE part (no I/O, no Kit) so it is unit-testable: find the holes, key each
 * parcel to the region's capability signature, and build/read the parcel markup.
 */

/** Sentinel parcel appended once the stream finishes, so waiting regions know to fall back to fetch. */
export const STREAM_DONE_SLOT = '__ogygia_done__';

/** `&amp;` in a Svelte-escaped attribute value (only `&` is relevant in a capability URL). */
const AMP_ENTITY = /&amp;/g;
/** `name` / `name="value"` pairs inside a tag's attribute text. Stateful (`g`) — reset before use. */
const ATTR_PAIR = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g;
/** A complete `<ogygia-region …>` opening tag. Stateful (`g`) — reset before use. */
const REGION_TAG = /<ogygia-region\b([^>]*)>/gi;
/** A literal `</template` that would break out of a parcel box. */
const TEMPLATE_CLOSE = /<\/template/i;

/** A deferred hole eligible for streaming: its signed endpoint + the slot key derived from it. */
export type StreamableRegion = {
	/** The signed capability URL (decoded — `&amp;` → `&`). */
	endpoint: string;
	/** Slot key (the capability `sig`), matched by the runtime to route the parcel. */
	slot: string;
};

/** Decode the minimal HTML entities Svelte emits in an attribute value (only `&` is relevant here). */
function decode_attr(value: string): string {
	return value.replace(AMP_ENTITY, '&');
}

/** Parse `name` / `name="value"` pairs out of a tag's attribute text. */
function parse_attrs(attr_text: string): Map<string, string> {
	const attrs = new Map<string, string>();
	ATTR_PAIR.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ATTR_PAIR.exec(attr_text))) {
		if (!m[1]) continue;
		attrs.set(m[1].toLowerCase(), m[2] ?? '');
	}
	return attrs;
}

/** The capability `sig` is the per-instance slot key (unique across holes on a page). */
export function region_slot_key(endpoint: string): string | null {
	const q = endpoint.indexOf('?');
	if (q === -1) return null;
	const params = new URLSearchParams(endpoint.slice(q + 1));
	const sig = params.get('sig');
	return sig || null;
}

/**
 * Find `<ogygia-region render="defer" when="load" endpoint="…">` holes to stream. Skips:
 * - `live` regions (they carry their own HTML already),
 * - `when` other than `load` (idle / visible / media intentionally defer the SERVER work too),
 * - holes with no endpoint.
 */
export function find_streamable_regions(html: string): StreamableRegion[] {
	const out: StreamableRegion[] = [];
	const seen = new Set<string>();
	REGION_TAG.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REGION_TAG.exec(html))) {
		const attrs = parse_attrs(m[1]);
		if (attrs.get('render') !== 'defer') continue;
		if (attrs.has('live')) continue;
		if ((attrs.get('when') || 'load') !== 'load') continue;
		const raw = attrs.get('endpoint');
		if (!raw) continue;
		const endpoint = decode_attr(raw);
		const slot = region_slot_key(endpoint);
		if (!slot || seen.has(slot)) continue;
		seen.add(slot);
		out.push({ endpoint, slot });
	}
	return out;
}

/**
 * Build a parcel `<template data-ogygia-slot="…">…rendered html…</template>`.
 * Returns null when the HTML contains a literal `</template` (which would break out of the box) — that
 * hole then simply falls back to the client fetch, so streaming never corrupts the page.
 */
export function build_parcel(slot: string, html: string): string | null {
	if (TEMPLATE_CLOSE.test(html)) return null;
	return `<template data-ogygia-slot="${slot}">${html}</template>`;
}

/** The done-sentinel parcel (empty template) the runtime watches to end the wait. */
export function done_parcel(): string {
	return `<template data-ogygia-slot="${STREAM_DONE_SLOT}"></template>`;
}
