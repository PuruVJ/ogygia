// ─────────────────────────────────────────────────────────────────────────────
// Frame — the one wire unit of the frames architecture (see internal/notes/frames.md).
//
// A region is a call (component + props); the call is the ADDRESS; content travels as frames:
// `{ a, v, html }`. Every delivery channel (defer fetch, streamed parcel, mutation fragment, live
// refresh) produces frames, and frames are only ever WRITTEN to the client frame-store — never
// applied to the DOM directly. Shared by server and client; keep it dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

export type Frame = {
	/** Address — the serialized call that produced this content. */
	a: string;
	/**
	 * Version ticket. Assigned at REQUEST time (not arrival time) by the store, so a slow response
	 * that started earlier can never overwrite one that started later. `write()` drops `v <=` applied.
	 */
	v: number;
	/** The content. HTML in, morph out — no component trees over the wire. */
	html: string;
};

/**
 * Address of a region: the CALL that produced it — region id + serialized props — NOT the full
 * signed URL. Critically, `exp` and `sig` vary per request (they're time + MAC), so keying on the
 * whole URL would give the same call a different address every request, and a mutation's fresh
 * region could never update a mounted one. Keying on `id|props` makes the address stable across
 * requests: same component + same props ⇒ same address, so single-flight updates land in place and
 * identical twins dedupe. Falls back to the raw endpoint when there's no query to parse.
 */
export function frameAddress(endpoint: string): string {
	const q = endpoint.indexOf('?');
	if (q === -1) return endpoint;
	const params = new URLSearchParams(endpoint.slice(q + 1));
	const id = params.get('id');
	const props = params.get('props');
	return id != null ? `${id}|${props ?? ''}` : endpoint.slice(0, q);
}
