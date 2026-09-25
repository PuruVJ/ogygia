/**
 * THE PROFILER SESSION COOKIE, read robustly. The profiler's user is often logged into the app they
 * profile, so their browser sends that app's whole cookie jar with every request — session, identity
 * and tracking cookies, easily kilobytes. The session must still be found in it, and when it is not,
 * the reason must be visible (a login that loops with no explanation is the failure this exists for).
 */
import type { RequestEvent } from '@sveltejs/kit';

export const SESSION_COOKIE = 'og_profiler';
/** Marks the navigation the login page makes right after a successful unlock: if THAT request still
 *  carries no session, the guard explains instead of sending the browser back to the login page. It
 *  carries no secret — only "a login just succeeded". */
export const AFTER_LOGIN_PARAM = 'og-after-login';

/** What a request that failed auth carried (profiler/index.ts `#cookie_diagnosis`). */
export interface CookieDiagnosis {
	/** a `Cookie` header arrived at all */
	header: boolean;
	/** its length in bytes (characters; cookie headers are ASCII) */
	bytes: number;
	/** how many `og_profiler=` pairs the raw header holds */
	pairs: number;
	/** whether Kit's own parser (`event.cookies.get`) found one */
	parsed: boolean;
}

/**
 * Every value of the cookie `name` in a raw `Cookie` header, in order — duplicates included (a
 * browser sends two same-named cookies when their paths or domains differ; a parser that keeps one
 * may keep the stale one). Percent-decoded where it decodes; kept raw where it does not, so one
 * malformed neighbour cannot hide the session.
 */
export function raw_cookie_values(header: string, name: string): string[] {
	const out: string[] = [];
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
		let value = part.slice(eq + 1).trim();
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
			value = value.slice(1, -1);
		try {
			value = decodeURIComponent(value);
		} catch {
			/* not percent-encoded as sent — the raw value is the candidate */
		}
		out.push(value);
	}
	return out;
}

/** Every candidate session value on a request: Kit's parsed cookie first, then every raw pair. */
export function session_cookie_values(event: RequestEvent): string[] {
	const out: string[] = [];
	const parsed = event.cookies.get(SESSION_COOKIE);
	if (parsed) out.push(parsed);
	const raw = event.request.headers.get('cookie');
	if (raw)
		for (const v of raw_cookie_values(raw, SESSION_COOKIE)) if (v && !out.includes(v)) out.push(v);
	return out;
}

/** The one-line account of a failed session, for the server log and the login page. */
export function describe_cookie_diagnosis(d: CookieDiagnosis): string {
	if (!d.header)
		return 'Logged in, but no Cookie header reached the server at all — a proxy or CDN in front of the app is not forwarding cookies to this path.';
	if (d.pairs === 0)
		return `Logged in, but your browser’s session cookie didn’t reach the server (Cookie header: ${d.bytes} bytes, no ${SESSION_COOKIE} in it) — a proxy or CDN dropped it, or the browser did not send it.`;
	if (d.pairs > 1)
		return `Logged in, but your browser sent ${d.pairs} ${SESSION_COOKIE} cookies (Cookie header: ${d.bytes} bytes) and none is the current session — clear this site’s cookies for the profiler path and log in again.`;
	return `Logged in, but the ${SESSION_COOKIE} cookie that arrived (Cookie header: ${d.bytes} bytes${d.parsed ? '' : ', not found by the cookie parser'}) is not a valid session — the profiler secret may differ between server instances.`;
}
