/**
 * Kit's two configurable directories, read from the app's `svelte.config.js`: `kit.files.routes`
 * (default `src/routes`) and `kit.outDir` (default `.svelte-kit`). ogygia scans the routes tree
 * (csr worlds, the client-build keepalive, route options) and writes/reads its island-deps handoff
 * under Kit's output dir — every one of those must follow the app's configuration, not the
 * defaults (an app building two route trees from one source, `PES_MODE=v2 → src/routes-v2` +
 * `.svelte-kit-v2`, had its all-csr=false tree read as "no routes": Kit skipped the client build,
 * the runtime chunk was never emitted, every island 404'd).
 *
 * Loaded once per root in the plugin's `config` hook (before Kit reads the routes); the compiler
 * reads the cached answer through `kit_dirs(root)` in compiler/kit.ts. Node-only (imports the
 * config module) — that is why it lives on the Vite side, not in the host-neutral compiler.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { set_kit_dirs, type KitDirs, DEFAULT_KIT_DIRS } from '../compiler/kit.js';

const CONFIG_FILES = ['svelte.config.js', 'svelte.config.mjs'];

/** Resolve `{ routes_dir, out_dir }` for `root` from its svelte config (defaults when absent or
 *  unreadable) and cache it for the compiler. */
export async function load_kit_dirs(root: string): Promise<KitDirs> {
	let kit: { files?: { routes?: string }; outDir?: string } = {};
	const file = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => existsSync(f));
	if (file) {
		try {
			const mod = (await import(pathToFileURL(file).href)) as { default?: { kit?: typeof kit } };
			kit = mod.default?.kit ?? {};
		} catch (e) {
			console.warn(
				`[ogygia] could not read ${path.relative(root, file)} for kit.files.routes / kit.outDir — using the defaults (${DEFAULT_KIT_DIRS.routes}, ${DEFAULT_KIT_DIRS.out}). ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}
	const dirs: KitDirs = {
		routes_dir: path.resolve(root, kit.files?.routes ?? DEFAULT_KIT_DIRS.routes),
		out_dir: path.resolve(root, kit.outDir ?? DEFAULT_KIT_DIRS.out)
	};
	set_kit_dirs(root, dirs);
	return dirs;
}
