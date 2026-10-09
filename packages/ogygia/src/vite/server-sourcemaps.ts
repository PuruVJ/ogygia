/**
 * PROFILER ON → the SERVER build writes hidden sourcemaps: `.map` files beside the server chunks, no
 * `//# sourceMappingURL` comment. They stay on the server (a browser never loads a server chunk),
 * and the profiler reads `<chunk>.map` to name every line by its source — a load's lines, a
 * component's markup, where a late island's data is fetched — on the host that runs the build
 * (Amplify, Lambda).
 *
 * After Kit's own config hook (`order: 'post'`): that is where Kit marks the build as the server one.
 * Kit then starts the CLIENT build with the server's `sourcemap` setting copied in. Maps left in the
 * client output would be served to anyone, so the client build keeps them hidden and MOVES them out
 * of its output the moment it has written it — into `.svelte-kit/ogygia-client-maps/`, which no
 * adapter copies. The server build (whose writeBundle ran this client build, and whose closeBundle
 * comes before Kit's adapter) then embeds the app's own ones into the profiler's maps module
 * (vite/profiler-maps.ts): the browser's CPU traces name the app's functions by their source line.
 * An app's own `build.sourcemap` choice wins both ways (its maps are its to serve, or not to make).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** app roots whose server build THIS process gave hidden maps (Kit's client build runs as a second
 *  `vite.build` with fresh plugin instances, in the same process; two apps built in one process each
 *  keep their own answer) */
const SERVER_MAPS = Symbol.for('ogygia.server-hidden-maps');

/** where the client build's maps are kept, off the served output: `<kit outDir>/ogygia-client-maps` */
export const CLIENT_MAPS_DIR = 'ogygia-client-maps';

/** `<kit outDir>/output/client` → `<kit outDir>/ogygia-client-maps` */
export function client_maps_stash(client_dir: string): string {
	return path.join(client_dir, '..', '..', CLIENT_MAPS_DIR);
}

export function server_sourcemaps_plugin(profiler_on: boolean): Plugin {
	const g = globalThis as { [SERVER_MAPS]?: Set<string> };
	/** this instance is the client build of a server build that got hidden maps from us */
	let client_ours = false;
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
				// the client build: what it inherited from the server build was ours, not the app's —
				// kept hidden, and moved off the output below
				if (ours.has(root) && config.build?.sourcemap === 'hidden') client_ours = true;
			}
		},
		// THE CLIENT'S MAPS, OFF THE OUTPUT: every `.map` this build wrote moves to the stash, before any
		// other step (Kit's own, an adapter's) can copy the output; the stash starts empty each build
		writeBundle: {
			order: 'post',
			sequential: true,
			handler(options, bundle) {
				if (!client_ours || !options.dir) return;
				const stash = client_maps_stash(options.dir);
				fs.rmSync(stash, { recursive: true, force: true });
				// (a chunk's map is written beside it, and not always listed in the bundle: each file's
				// `<file>.map` is looked for, and any listed `.map` too)
				const maps = new Set<string>();
				for (const file of Object.keys(bundle)) maps.add(file.endsWith('.map') ? file : file + '.map');
				for (const file of maps) {
					const from = path.join(options.dir, file);
					if (!fs.existsSync(from)) continue;
					const to = path.join(stash, file);
					try {
						fs.mkdirSync(path.dirname(to), { recursive: true });
						fs.renameSync(from, to);
					} catch {
						// never leave one behind: a map that cannot be kept is deleted
						fs.rmSync(from, { force: true });
					}
				}
			}
		}
	};
}
