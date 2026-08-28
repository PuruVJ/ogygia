import { base } from '$app/paths';
import { routes, page, layout } from 'ogygia/router';
// DISTRIBUTED ROUTES: a table fragment shipped by a dependency (`ogygia.files`-declared) —
// its pages + the islands inside them compile like app source (e2e/island-pkg.ts).
import { pkg_table } from 'repro-island-pkg/routes';
import Shell from '$lib/rtr/Shell.svelte';
import Inner from '$lib/rtr/Inner.svelte';
import Home from '$lib/rtr/Home.svelte';
import Deep from '$lib/rtr/Deep.svelte';

// v2: layouts are named table→table wrappers; nesting = spreading a wrapped sub-table. Deep's `data`
// merges shell.who + inner.nav (Kit's cascade), so it needs no load of its own. Endpoints are the
// plain `{ GET }` object form; this Kit route file itself exports `GET` (the HTTP handler below).
const shell = layout('shell', Shell, { load: () => ({ who: 'ada' }) });
const inner = layout('inner', Inner, { load: () => ({ nav: 'sidebar-42' }) });

const app = routes(
	shell({
		'/': page(Home),
		...inner({ '/deep': page(Deep) }),
		...pkg_table,
		'/api/ping': { GET: (c) => c.json({ pong: true }) }
	}),
	// Mounted under the Kit route `rtr/[...path]` — derive the mount from Kit's own base.
	{ base: `${base}/rtr` }
);

export const GET = async (event: { request: Request }) =>
	(await app.fetch(event.request, event as never)) ?? new Response('Not found', { status: 404 });
