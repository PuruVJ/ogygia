/**
 * The flags plugin's server half (imported by the build through `virtual:ogygia/server-plugins`).
 * `request`: prime the decision source once, above the page / hole split, so every read stays sync.
 * `done`: drain queued exposures at the request's end, always (the serverless-safe tail).
 */
import { defineServer, type ServerPlugin } from 'ogygia/plugin';
import { prime_flags, flush_exposures } from './index.js';

const server: ServerPlugin = defineServer({
	async request({ event }) {
		await prime_flags({ request: event.request, url: event.url, cookies: event.cookies });
	},
	done() {
		flush_exposures();
	}
});
export default server;
