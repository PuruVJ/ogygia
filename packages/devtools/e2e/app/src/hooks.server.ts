import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';
import { setProfilerStore } from '@ogygia/devtools/profiler/storage';
import { sqliteStore } from '@ogygia/devtools/profiler/storage/sqlite';
import { ds_ssr } from '$lib/hell/ds-ssr';
import { scoped_render } from '$lib/restorelab/scoped-render';

// DEMO: give the profiler a durable SQLite store so reports survive a restart and the sidebar's
// shared list fills. Swap for redisStore(...) / postgresStore(process.env.DATABASE_URL) in a real
// deployment; this is the one line an app writes to make the profiler DB-backed.
// (`OGYGIA_PROFILES_DB`: the e2e serverless spec gives each "fresh instance" an empty database)
setProfilerStore(sqliteStore(process.env.OGYGIA_PROFILES_DB || '.ogygia/profiles.db'));

// FOREIGN-MUTATION fixture (/detector): corrupt the FIRST island's region HTML after SSR — strip
// Svelte's `<!--[-->` hydration anchors inside it, the way a post-SSR HTML middleware does. Svelte's
// hydration must then discard that island's server DOM and re-render; the devtools' recovered-island
// finding must name EXACTLY that island and not its healthy sibling.
const corrupt_detector_region: Handle = async ({ event, resolve }) => {
	if (event.url.pathname !== '/detector') return resolve(event);
	return resolve(event, {
		transformPageChunk: ({ html, done }) => {
			if (!done) return html;
			const start = html.indexOf('<ogygia-region');
			const end = html.indexOf('</ogygia-region>', start);
			if (start === -1 || end === -1) return html;
			const block = html.slice(start, end);
			return html.slice(0, start) + block.replaceAll('<!--[-->', '') + html.slice(end);
		}
	});
};

// A WALL IN FRONT of ogygia.handle() (/dt-batch): `og-auth-wall=post` refuses only the BATCH request
// (a POST) — a firewall rule or a method filter that allows GET on the path: the holes still fill,
// each on its own request, and the devtools name the refused batch.
const auth_wall: Handle = async ({ event, resolve }) => {
	if (
		event.cookies.get('og-auth-wall') === 'post' &&
		event.url.pathname.startsWith('/__ogygia__') &&
		event.request.method === 'POST'
	)
		return new Response('Method Not Allowed', { status: 405 });
	return resolve(event);
};

// THE TTFB-GAP LAB (/dt-gap): a visitor's request is held 900 ms where the profiler's own renders
// (`x-og-profiler-internal`) are not, so the browser's first byte and the server's render part.
// `?front`: held IN FRONT of ogygia.handle() — before the profiler's handler takes the request (like
// a proxy or an auth hop); `?inside`: held after it — inside the handler, outside the render.
const gap_wait = (event: Parameters<Handle>[0]['event'], mode: string) =>
	event.url.pathname === '/dt-gap' &&
	event.url.searchParams.has(mode) &&
	!event.request.headers.get('x-og-profiler-internal')
		? new Promise((ok) => setTimeout(ok, 900))
		: null;
const gap_front: Handle = async ({ event, resolve }) => {
	await gap_wait(event, 'front');
	return resolve(event);
};
const gap_inside: Handle = async ({ event, resolve }) => {
	await gap_wait(event, 'inside');
	return resolve(event);
};

// THE STAMPED-COOKIE fixture (/dt-cookie): a hook that sets a visitor-id cookie on every answer of
// the path, the way a tracking or a session-touch hook does. The page itself is the same for every
// visitor, but no shared cache keeps an answer that sets a cookie: the profiler's same-document
// advice must say so before it says "cache it".
const stamp_cookie: Handle = async ({ event, resolve }) => {
	if (event.url.pathname === '/dt-cookie')
		event.cookies.set('og-visitor', crypto.randomUUID(), { path: '/' });
	return resolve(event);
};

// The SSR profiler is NOT wired here — `devtools({ profiler })` in vite.config.ts mounts it inside
// ogygia.handle(). UI at /__profiler (dev = open; prod needs ?key=<OGYGIA_PROFILER_SECRET>).
export const handle = sequence(
	stamp_cookie,
	// the hell page's design-system SSR pass (a Stencil renderer over the finished document): first
	// in the sequence so its page transform runs LAST, on ogygia's output (Kit applies them in reverse)
	ds_ssr,
	auth_wall,
	gap_front,
	// (the restore lab: a scoped web-component render as the app's transform, OGYGIA_RESTORE_LAB=1)
	ogygiaHandle(
		process.env.OGYGIA_RESTORE_LAB ? { transform: (html: string) => scoped_render(html) } : {}
	),
	gap_inside,
	corrupt_detector_region
);
