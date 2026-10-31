/**
 * The federation plugin's server realm (found by name: `@ogygia/federation/server`).
 *
 * `setup`: hold the app (facts, shared hooks, signer) and install the deferred-hole signer.
 * `request`: a `federate()` in hooks.server.ts serves `/og/fragment/*`, `/og/thaw` and the
 * deferred-hole endpoint straight from the handle (no route files) — above the page split: these are
 * their own protocol. Any other path falls through.
 * `invalidated` (shared hook): every invalidation of this app's stored pages tells the peers that
 * baked its fragments. A peer is notified whether or not it has a key (a pure consumer still needs to
 * drop its SWR copies). Fire and forget — a peer that is down never fails a publish.
 */
import { defineServer, type ServerPlugin } from 'ogygia/plugin';
import { set_fed_app } from './app.ts';
import { install_federation, serve_federation } from './serve.ts';
import { current_federation } from './registry.ts';
import { broadcast_thaw } from './federate.ts';

const server: ServerPlugin = defineServer({
	setup(app) {
		set_fed_app(app);
		install_federation(app);
	},

	async request({ event }) {
		const res = await serve_federation(event);
		if (res) return res;
	},

	invalidated(tags) {
		const fed = current_federation();
		if (!fed) return;
		void broadcast_thaw(fed, { id: crypto.randomUUID(), hop: 0, tags }).catch((e) => {
			console.warn('[ogygia] federation: thaw notice to peers failed —', e);
		});
	}
});
export default server;
