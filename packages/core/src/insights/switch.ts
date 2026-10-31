/**
 * THE DEVTOOLS SWITCH — whether devtools is on in this browser, in a BUILD with devtools (a QA or
 * preview deploy; the dev server always has it on). One cookie decides all of it: the launcher shows,
 * the page is measured from the start (runtime/beacon.ts), what islands leave running is watched
 * (leftovers.ts), and the server writes its event side-channel (hooks.ts). Off — the default — a
 * visitor sees nothing and pays nothing.
 *
 * A developer turns it on for their own browser, and it stays on across navigations and reloads:
 * - `?og-devtools=on` / `?og-devtools=off` on any page (the server sets the cookie on that very
 *   response, the browser too — a prerendered page has no server — and the address drops the param);
 * - `ogygia.devtools.on()` / `.off()` in the console;
 * - "hide" in the dock turns it off.
 *
 * (The value is not the `1` an earlier launcher set on a plain click: a browser that clicked the old
 * button once stays off until it opts in.)
 *
 * A plain module: the server, the runtime and the launcher all read it.
 */
export const DEVTOOLS_COOKIE = 'og_devtools';
export const DEVTOOLS_ON = 'on';
/** The URL param that flips it: `?og-devtools=on` / `?og-devtools=off`. */
export const DEVTOOLS_PARAM = 'og-devtools';
/** 30 days: a developer flips it once per deploy, not per visit. */
const MAX_AGE = 60 * 60 * 24 * 30;

/** What the URL asks for: `true` on, `false` off, `null` nothing (absent or another value). */
export function switch_in_url(url: URL): boolean | null {
	const v = url.searchParams.get(DEVTOOLS_PARAM);
	if (v === null) return null;
	if (v === 'on' || v === '1' || v === 'true') return true;
	if (v === 'off' || v === '0' || v === 'false') return false;
	return null;
}

/** The URL without the switch param (the address after it was applied). */
export function without_switch(url: URL): URL {
	const u = new URL(url);
	u.searchParams.delete(DEVTOOLS_PARAM);
	return u;
}

/** Is it on in a `Cookie` header / `document.cookie` string. */
export function switch_on_in(cookies: string): boolean {
	const want = DEVTOOLS_COOKIE + '=' + DEVTOOLS_ON;
	for (const c of cookies.split(';')) if (c.trim() === want) return true;
	return false;
}

/**
 * LEAN TESTING: `og_testing=lean` (or `?og-testing=lean`) beside the devtools switch — the testing API
 * (`window.__ogygia_testing`) works in full, and nothing else of devtools runs: no launcher, no dock, no
 * watcher of the page's timers, no server event side-channel in the HTML. The page loads what it loads
 * with devtools off, plus the testing engine when a test first asks. An engine that does not know the
 * cookie ignores it.
 */
export const TESTING_COOKIE = 'og_testing';
export const TESTING_LEAN = 'lean';
export const TESTING_PARAM = 'og-testing';

/** Is lean testing asked for in a `Cookie` header / `document.cookie` string. */
export function lean_in(cookies: string): boolean {
	const want = TESTING_COOKIE + '=' + TESTING_LEAN;
	for (const c of cookies.split(';')) if (c.trim() === want) return true;
	return false;
}

/** Lean testing in this browser: the cookie, or the URL param (false off the browser). */
export function testing_lean(): boolean {
	try {
		return (
			lean_in(document.cookie) ||
			new URL(location.href).searchParams.get(TESTING_PARAM) === TESTING_LEAN
		);
	} catch {
		return false;
	}
}

/** The `Set-Cookie`-shaped attributes the switch is written with (browser and server alike). */
export const SWITCH_COOKIE_OPTIONS: {
	path: string;
	maxAge: number;
	sameSite: 'lax';
	httpOnly: boolean;
} = { path: '/', maxAge: MAX_AGE, sameSite: 'lax' as const, httpOnly: false };

/** Is it on in this browser (false off the browser, or with cookies blocked). */
export function devtools_switched_on(): boolean {
	try {
		return switch_on_in(document.cookie);
	} catch {
		return false;
	}
}

/** Turn it on / off in this browser (the cookie; the caller updates what shows). */
export function write_switch(on: boolean): void {
	try {
		document.cookie = on
			? `${DEVTOOLS_COOKIE}=${DEVTOOLS_ON}; path=/; max-age=${MAX_AGE}; samesite=lax`
			: `${DEVTOOLS_COOKIE}=; path=/; max-age=0; samesite=lax`;
	} catch {
		// cookies off: nothing remembers it
	}
}
