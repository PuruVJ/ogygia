import { sequence } from '@sveltejs/kit/hooks';
import { handle as ogygiaHandle } from 'ogygia/server';
import { artifacts, akamai, cloudfront } from 'ogygia/artifacts';
import { env } from '$env/dynamic/private';

// Edge adapters point at the harness's EMULATORS when their base URLs are set (e2e/artifacts.ts
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
if (edge.length) artifacts.configure({ edge });

export const handle = sequence(ogygiaHandle());
