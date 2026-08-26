import { base } from '$app/paths';
import { routes } from 'ogygia/router';
import Shell from '$lib/rtr/Shell.svelte';
import Inner from '$lib/rtr/Inner.svelte';
import Home from '$lib/rtr/Home.svelte';
import Deep from '$lib/rtr/Deep.svelte';

const app = routes(
	(r) =>
		r
			.layout(Shell)
			.load(() => ({ who: 'ada' }))
			.routes({
				'/': (r) => r.page(Home),
				'/deep': (r) =>
					r
						.layout(Inner)
						.load(() => ({ nav: 'sidebar-42' }))
						.routes({ '/': (r) => r.page(Deep).load((c) => ({ who: c.data.who, nav: c.data.nav })) }),
				'/api/ping': (r) => r.GET((c) => c.json({ pong: true }))
			}),
	// Mounted under the Kit route `rtr/[...path]` — derive the mount from Kit's own base so the
	// fixture works with or without a configured base (it was hardcoded '/base/rtr' before, which
	// never matched this base-less app: every rtr URL 404'd).
	{ base: `${base}/rtr` }
);

export const GET = async (event) =>
	(await app.fetch(event.request, event)) ?? new Response('Not found', { status: 404 });
