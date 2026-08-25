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
	{ base: '/base/rtr' }
);

export const GET = (event) => app.fetch(event.request, event);
