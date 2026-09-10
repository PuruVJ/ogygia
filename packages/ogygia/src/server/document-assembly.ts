/**
 * DOCUMENT ASSEMBLY — how the handle puts its head and body injections into Kit's page HTML.
 *
 * Kit hands `transformPageChunk` the whole document as one string on a non-streamed page (2.6 MB on
 * a large CMS page). Everything ogygia adds goes to exactly two places: just before `</head>` and
 * just before `</body>`. So the document is located ONCE — `</head>` from the front (it sits within
 * the first few KB), `</body>` from the back (the last few bytes) — and assembled ONCE from slices:
 * `head + head_inject + middle + body_inject + rest`. V8 keeps `slice` results and `+` chains as
 * views and ropes, so the body bytes are never copied here; Kit flattens the result once when it
 * encodes the response. Before this, the transform ran eight to nine whole-document regex/replace
 * passes and made four to five full copies per request (~13 MB of transient garbage on that page).
 *
 * Every presence check and dedupe the handle still does runs on the HEAD SLICE alone (see
 * head-presence.ts); the csr fact is a build-time route fact (context.ts), not a scan.
 */

export interface DocumentSpans {
	/** Index of `</head>` (-1 when this chunk has none — a streamed body chunk). */
	head_end: number;
	/** Index of the LAST `</body>` (-1 when this chunk has none — a streamed head/middle chunk). */
	body_end: number;
}

const HEAD_CLOSE = '</head>';
const BODY_CLOSE = '</body>';

/** The two injection points, each found with one bounded scan. */
export function locate(html: string): DocumentSpans {
	return { head_end: html.indexOf(HEAD_CLOSE), body_end: html.lastIndexOf(BODY_CLOSE) };
}

/**
 * Put `head_inject` before `</head>` and `body_inject` before `</body>`, replacing the head slice
 * with `head` when the caller rewrote it (the deduped head; `null` = unchanged). A missing
 * injection point drops that injection (a streamed chunk without `</body>` gets no body work).
 * Returns `html` itself when there is nothing to do.
 */
export function assemble(
	html: string,
	{ head_end, body_end }: DocumentSpans,
	head: string | null,
	head_inject: string,
	body_inject: string
): string {
	const has_head = head_end !== -1 && (head !== null || head_inject !== '');
	const has_body = body_end !== -1 && body_inject !== '';
	if (!has_head && !has_body) return html;
	if (!has_head) return html.slice(0, body_end) + body_inject + html.slice(body_end);
	const front = (head ?? html.slice(0, head_end)) + head_inject;
	if (!has_body) return front + html.slice(head_end);
	return front + html.slice(head_end, body_end) + body_inject + html.slice(body_end);
}
