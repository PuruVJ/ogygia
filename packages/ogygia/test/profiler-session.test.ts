// THE PROFILER SESSION in a real browser's cookie jar (src/profiler/session-cookie.ts). The profiler's
// user is usually logged into the app they profile, so their requests carry that app's large cookie
// jar. Field report: a logged-in user looped on the login page while a clean client (curl, a private
// window) worked. Pinned here: every `og_profiler` value counts (not only the one a parser kept), a
// login that still has no session explains itself instead of looping, and the server logs the facts
// (never a cookie value).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { profiler } from '../src/profiler/index.js';
import {
	AFTER_LOGIN_PARAM,
	describe_cookie_diagnosis,
	raw_cookie_values
} from '../src/profiler/session-cookie.js';

// production auth (dev opens the profiler without a key)
const dev_switch = vi.hoisted(() => ({ dev: true }));
vi.mock('../src/profiler/env.js', () => ({ detect_dev: () => dev_switch.dev }));

const SECRET = 'prof-key';
const BIG_JAR = Array.from({ length: 40 }, (_, i) => `app_cookie_${i}=${'x'.repeat(180)}`).join(
	'; '
);
const COOKIE_PAIR_RE = /^og_profiler=([^;]*)/;

/** A request to the profiler with a raw Cookie header; `parsed` is what Kit's parser would return. */
function event(
	path: string,
	cookie: string | null,
	parsed?: string,
	init: RequestInit = {}
): RequestEvent {
	const url = new URL('http://localhost' + path);
	const headers = new Headers(init.headers);
	if (cookie != null) headers.set('cookie', cookie);
	return {
		url,
		request: new Request(url, { ...init, headers }),
		route: { id: null },
		cookies: {
			get: (k: string) => (k === 'og_profiler' ? parsed : undefined),
			set() {},
			delete() {},
			getAll: () => [],
			serialize: () => ''
		},
		fetch: async () => new Response('ok')
	} as unknown as RequestEvent;
}

async function setup() {
	dev_switch.dev = false;
	const handle = profiler({ secret: SECRET });
	const run = (e: RequestEvent) => handle({ event: e, resolve: async () => new Response('app') });
	const login = await run(
		event('/__profiler/login', null, undefined, {
			method: 'POST',
			body: JSON.stringify({ key: SECRET, next: '/__profiler' })
		})
	);
	const token = COOKIE_PAIR_RE.exec(
		login.headers.getSetCookie().find((c) => c.startsWith('og_profiler='))!
	)![1];
	return { run, login, token };
}

afterEach(() => {
	dev_switch.dev = true;
	vi.restoreAllMocks();
});

describe('raw_cookie_values', () => {
	it('every same-named pair, in order; only that exact name', () => {
		expect(
			raw_cookie_values('a=1; og_profiler=old; xog_profiler=no; og_profiler=new', 'og_profiler')
		).toEqual(['old', 'new']);
	});
	it('decodes what decodes, keeps the raw value where it does not, strips quotes', () => {
		expect(raw_cookie_values('og_profiler=%zz; og_profiler="q%20v"', 'og_profiler')).toEqual([
			'%zz',
			'q v'
		]);
	});
});

describe('the profiler session in a large cookie jar', () => {
	it('a valid session is found behind a stale same-named cookie the parser kept', async () => {
		const { run, token } = await setup();
		const res = await run(
			event('/__profiler', `${BIG_JAR}; og_profiler=stale; og_profiler=${token}`, 'stale')
		);
		expect(res.status).not.toBe(302);
		expect(res.headers.get('location')).toBeNull();
	});

	it('a valid session the parser missed entirely (a malformed neighbour) still counts', async () => {
		const { run, token } = await setup();
		const res = await run(event('/__profiler', `bad=%E0%A4%A; og_profiler=${token}`, undefined));
		expect(res.headers.get('location')).toBeNull();
	});

	it('the login response sends the browser on with the after-login marker', async () => {
		const { login } = await setup();
		const body = (await login.json()) as { next: string };
		expect(body.next).toBe(`/__profiler?${AFTER_LOGIN_PARAM}=1`);
	});

	it('right after login with no session: the login page explains, and the server logs facts, not values', async () => {
		const { run, token } = await setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await run(event(`/__profiler?${AFTER_LOGIN_PARAM}=1`, BIG_JAR));
		const location = res.headers.get('location')!;
		expect(location).toBe('/__profiler/login?next=%2F__profiler&session=1');
		const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
		expect(logged).toContain(`"bytes":${BIG_JAR.length}`);
		expect(logged).toContain('"pairs":0');
		expect(logged).not.toContain(token);
		// the login page the guard sent the browser to renders the diagnosis
		const page = await run(event(location, BIG_JAR));
		const html = await page.text();
		expect(html).toContain('data-session-problem');
		expect(html).toContain(`Cookie header: ${BIG_JAR.length} bytes`);
	});

	it('an ordinary visit without a session is sent to the login page, no diagnosis', async () => {
		const { run } = await setup();
		const res = await run(event('/__profiler/run', null));
		expect(res.headers.get('location')).toBe('/__profiler/login?next=%2F__profiler%2Frun');
		const html = await (await run(event('/__profiler/login?next=%2F__profiler', null))).text();
		expect(html).not.toContain('data-session-problem');
	});
});

describe('describe_cookie_diagnosis', () => {
	it('tells a dropped cookie, a duplicate, a wrong secret and no header apart', () => {
		expect(
			describe_cookie_diagnosis({ header: false, bytes: 0, pairs: 0, parsed: false })
		).toContain('no Cookie header');
		expect(
			describe_cookie_diagnosis({ header: true, bytes: 9000, pairs: 0, parsed: false })
		).toContain('9000 bytes, no og_profiler');
		expect(
			describe_cookie_diagnosis({ header: true, bytes: 900, pairs: 2, parsed: true })
		).toContain('sent 2 og_profiler cookies');
		expect(
			describe_cookie_diagnosis({ header: true, bytes: 900, pairs: 1, parsed: true })
		).toContain('not a valid session');
	});
});
