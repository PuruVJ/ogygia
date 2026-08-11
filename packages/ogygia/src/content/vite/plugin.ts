import fs from 'node:fs';
import path from 'node:path';
import type { ModuleNode, Plugin, ViteDevServer } from 'vite';

const BACKSLASH = /\\/g;
const REMOTE_FILE = /\.remote\.(ts|js|mts|mjs)$/;

export type ContentPluginOptions = {
	/**
	 * Extra absolute dirs to watch in dev (in addition to `src/content`).
	 * Usually unnecessary — Vite already tracks `import.meta.glob` deps from `.remote.ts`.
	 */
	watchDirs?: string[];
	/**
	 * Dev: debounce filesystem events before full-reload (ms).
	 * Default `50`.
	 */
	hmrDebounceMs?: number;
};

/**
 * Invalidate a module and every importer.
 * Returns how many modules were touched.
 */
export function invalidateModuleTree(server: ViteDevServer, entry: ModuleNode | undefined) {
	if (!entry) return 0;
	const seen = new Set<ModuleNode>();
	const stack: ModuleNode[] = [entry];
	while (stack.length) {
		const mod = stack.pop()!;
		if (seen.has(mod)) continue;
		seen.add(mod);
		server.moduleGraph.invalidateModule(mod);
		for (const importer of mod.importers) stack.push(importer);
	}
	return seen.size;
}

function is_remote_module(id: string) {
	const bare = id.split('?')[0].replace(BACKSLASH, '/');
	return REMOTE_FILE.test(bare);
}

/**
 * Vite plugin for RF-native content HMR.
 *
 * Sources live inside `.remote.ts` via `content({ from: import.meta.glob(...) })`.
 * On content file changes: invalidate remotes → full-reload so SSR catalogs refresh.
 *
 * ```ts
 * // vite.config.ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import content from 'ogygia/content/vite';
 *
 * export default {
 *   plugins: [content(), sveltekit()]
 * };
 * ```
 */
export function content(options: ContentPluginOptions = {}): Plugin {
	const debounceMs = Math.max(0, options.hmrDebounceMs ?? 50);
	let root = '';

	return {
		name: 'ogygia:content',
		enforce: 'pre',

		configResolved(config) {
			root = config.root;
		},

		configureServer(server) {
			let timer: ReturnType<typeof setTimeout> | null = null;
			let pending = new Set<string>();

			const watchRoots = new Set<string>();
			const contentDir = path.resolve(root, 'src/content');
			if (fs.existsSync(contentDir)) watchRoots.add(contentDir);
			for (const d of options.watchDirs ?? []) {
				watchRoots.add(path.resolve(d));
			}

			const under_watch = (abs: string) => {
				for (const base of watchRoots) {
					if (abs === base || abs.startsWith(base + path.sep)) return true;
				}
				return is_remote_module(abs);
			};

			const flush = async () => {
				timer = null;
				const files = [...pending];
				pending.clear();
				if (files.length === 0) return;

				let invalidated = 0;
				for (const file of files) {
					const mods = server.moduleGraph.getModulesByFile(file);
					if (mods) {
						for (const mod of mods) invalidated += invalidateModuleTree(server, mod);
					}
				}

				// Also poke every loaded .remote.ts so catalogs re-evaluate even if
				// the glob edge wasn't linked yet (e.g. new file matching a pattern).
				for (const mod of server.moduleGraph.idToModuleMap.values()) {
					const id = mod.id ?? mod.file ?? '';
					if (is_remote_module(id)) {
						invalidated += invalidateModuleTree(server, mod);
					}
				}

				server.config.logger.info(
					`[ogygia/content] sources changed (${files.length} file(s)) → invalidate ${invalidated} module(s), full-reload`
				);
				server.ws.send({ type: 'full-reload', path: '*' });
			};

			const schedule = (file: string) => {
				const abs = path.resolve(file);
				const base = path.basename(abs);
				if (base.endsWith('~') || base.startsWith('.#')) return;
				if (!under_watch(abs)) return;
				pending.add(abs);
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					void flush();
				}, debounceMs);
			};

			server.watcher.on('add', schedule);
			server.watcher.on('change', schedule);
			server.watcher.on('unlink', schedule);

			for (const dir of watchRoots) {
				if (fs.existsSync(dir)) server.watcher.add(dir);
			}
		}
	};
}
