/**
 * The flags plugin's server realm (found by name: `@ogygia/flags/server`).
 * `request`: prime the decision source once, above the page / hole split, so every read stays sync.
 * `done`: drain queued exposures at the request's end, always (the serverless-safe tail).
 */
import { defineServer, type ServerPlugin } from 'ogygia/plugin';
import { prime_flags, flush_exposures } from './index.ts';
import { set_flags_app } from './app.ts';

const server: ServerPlugin = defineServer({
	setup(app) {
		set_flags_app(app);
	},
	async request({ event }) {
		await prime_flags({ request: event.request, url: event.url, cookies: event.cookies });
	},
	done() {
		flush_exposures();
	}
});
export default server;
