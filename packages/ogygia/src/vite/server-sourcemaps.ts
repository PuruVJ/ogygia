/**
 * PROFILER ON → the SERVER build writes hidden sourcemaps: `.map` files beside the server chunks, no
 * `//# sourceMappingURL` comment. They stay on the server (a browser never loads a server chunk),
 * and the profiler reads `<chunk>.map` to name every line by its source — a load's lines, a
 * component's markup, where a late island's data is fetched — on the host that runs the build
 * (Amplify, Lambda).
 *
 * After Kit's own config hook (`order: 'post'`): that is where Kit marks the build as the server one.
 * Kit then starts the CLIENT build with the server's `sourcemap` setting copied in; maps there would
 * be served to anyone, so the client build gets them back off — when this turned them on. An app's
 * own `build.sourcemap` choice wins both ways.
 */
import path from 'node:path';
import type { Plugin } from 'vite';

/** app roots whose server build THIS process gave hidden maps (Kit's client build runs as a second
 *  `vite.build` with fresh plugin instances, in the same process; two apps built in one process each
 *  keep their own answer) */
const SERVER_MAPS = Symbol.for('ogygia.server-hidden-maps');

export function server_sourcemaps_plugin(profiler_on: boolean): Plugin {
	const g = globalThis as { [SERVER_MAPS]?: Set<string> };
	return {
		name: 'ogygia:server-sourcemaps',
		config: {
			order: 'post',
			handler(config, env) {
				if (!profiler_on || env.command !== 'build') return;
				const ours = (g[SERVER_MAPS] ??= new Set());
				const root = path.resolve(config.root ?? '.');
				if (config.build?.ssr) {
					// (each server build decides afresh: an earlier build of this app is not this one)
					ours.delete(root);
					if (config.build.sourcemap !== undefined) return;
					ours.add(root);
					return { build: { sourcemap: 'hidden' } };
				}
				// the client build: what it inherited from the server build was ours, not the app's
				if (ours.has(root) && config.build?.sourcemap === 'hidden')
					return { build: { sourcemap: false } };
			}
		}
	};
}
