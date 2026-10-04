/**
 * A REDIRECT WRITTEN AS A PAGE. A prerendered route that redirects has no server to answer 3xx, so
 * the build writes a stub in its place — `<meta http-equiv="refresh" content="0;url=/to">` (and a
 * script that sets `location.href`) — and the host answers it 200. Profiled as it is, it read as
 * "only 118 bytes: not a render". The page it sends the visitor to is the one to profile.
 */

/** the largest body read as a stub: a real page with a refresh tag is a page, not a redirect */
const STUB_MAX_BYTES = 2048;

/** The path a redirect stub sends the visitor to (`/to?q`), or null when `body` is not one. */
export function refresh_target(body: string, origin: string): string | null {
	if (!body || body.length > STUB_MAX_BYTES) return null;
	const lower = body.toLowerCase();
	const at = lower.indexOf('http-equiv="refresh"');
	if (at < 0) return null;
	// the tag around it: its content attribute, whichever side of http-equiv it sits on
	const open = lower.lastIndexOf('<meta', at);
	const close = lower.indexOf('>', at);
	if (open < 0 || close < 0) return null;
	const tag = body.slice(open, close);
	const c = tag.toLowerCase().indexOf('content="');
	if (c < 0) return null;
	const content = tag.slice(c + 9, tag.indexOf('"', c + 9));
	// `0;url=/to` (or `0; URL='/to'`): what follows `url=`, quotes off
	const u = content.toLowerCase().indexOf('url=');
	if (u < 0) return null;
	let to = content.slice(u + 4).trim();
	const q = to[0];
	if (q === "'" || q === '"') to = to.endsWith(q) && to.length > 1 ? to.slice(1, -1) : to.slice(1);
	if (!to) return null;
	try {
		const url = new URL(to, origin);
		if (url.origin !== new URL(origin).origin) return null;
		return url.pathname + url.search;
	} catch {
		return null;
	}
}
