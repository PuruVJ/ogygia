import { sequence } from '@sveltejs/kit/hooks';
import { handle as ogygiaHandle } from 'ogygia/server';
import { freeze, akamai, cloudfront } from 'ogygia/freeze';
import { env } from '$env/dynamic/private';
import { routes, page, layout } from 'ogygia/router';
import Shell from '$lib/r/Shell.svelte';
import Frozen from '$lib/r/Frozen.svelte';
import Plain from '$lib/r/Plain.svelte';
import Off from '$lib/r/Off.svelte';

// Edge adapters point at the harness's EMULATORS when their base URLs are set (e2e/freeze.ts
// boots them) — the REAL adapters run unchanged, signing included; the emulators verify the
// signature STRUCTURE and speak each CDN's real purge API. No env → origin store only (lane 1).
const edge = [];
if (env.EDGE_AKAMAI_URL) {
	edge.push(
		akamai({
			host: 'akab-emulated.purge.akamaiapis.net',
			clientToken: 'emu-client-token',
			clientSecret: 'emu-client-secret',
			accessToken: 'emu-access-token',
			site: env.EDGE_SITE_URL || 'http://127.0.0.1:3073',
			baseUrl: env.EDGE_AKAMAI_URL
		})
	);
}
if (env.EDGE_CF_URL) {
	edge.push(
		cloudfront({
			distributionId: 'EMULATED123',
			accessKeyId: 'AKIAEMULATED',
			secretAccessKey: 'emulated-secret',
			baseUrl: env.EDGE_CF_URL
		})
	);
}
if (edge.length) freeze.configure({ edge });

// A programmatic table mounted INSIDE the freeze handle (deck S17): Kit's file router never claims
// /r/*, so `event.route.id` is null there and the handle asks the table. `page(C, { freeze })`
// cascades page > layout > table; undeclared follows the config default (this fixture: on).
const shell = layout('r', Shell, { freeze: true }); // layout-level opt-in…
const app = routes({
	...shell({
		'/r/frozen': page(Frozen),
		'/r/off': page(Off, { freeze: false }) // …a page below overrides it
	}),
	'/r/plain': page(Plain) // nothing declared anywhere → config default (on)
});

export const handle = sequence(ogygiaHandle(), app.handle);
