/**
 * Kit's two configurable directories, read from the app's Kit config: `files.routes` (default
 * `src/routes`) and `outDir` (default `.svelte-kit`). ogygia scans the routes tree (csr worlds, the
 * client-build keepalive, route options) and writes/reads its island-deps handoff under Kit's output
 * dir — every one of those must follow the app's configuration, not the defaults (an app building
 * two route trees from one source, `PES_MODE=v2 → src/routes-v2` + `.svelte-kit-v2`, had its
 * all-csr=false tree read as "no routes": Kit skipped the client build, the runtime chunk was never
 * emitted, every island 404'd).
 *
 * WHERE THE CONFIG IS. Kit's own plugin carries its validated config (`vite-plugin-sveltekit-setup`'s
 * `api.options`): on Kit 2 the svelte config, Kit's options under `kit`; on Kit 3, which takes its
 * config in `vite.config.js` only (a `svelte.config.js` is an error there), Kit's options at the top.
 * Read from there first; a Kit 2 app's `svelte.config.js` file is the fallback.
 *
 * Loaded once per root in the plugin's `config` hook (before Kit reads the routes); the compiler
 * reads the cached answer through `kit_dirs(root)` in compiler/kit.ts. Node-only (imports the
 * config module) — that is why it lives on the Vite side, not in the host-neutral compiler.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
	set_kit_dirs,
	set_kit_inline_style_threshold,
	type KitDirs,
	DEFAULT_KIT_DIRS
} from '../compiler/kit.js';

const CONFIG_FILES = ['svelte.config.js', 'svelte.config.mjs'];

type KitOptions = { files?: { routes?: string }; outDir?: string; inlineStyleThreshold?: number };

/** The plugin list as a Vite config holds it: plugins, arrays of them, promises of either, falsy. */
type PluginOption = unknown;

/** Every plugin in `option`, flattened (arrays nest; `sveltekit()` is a promise on Kit 3). */
async function flatten_plugins(option: PluginOption): Promise<{ name?: string; api?: unknown }[]> {
	const out: { name?: string; api?: unknown }[] = [];
	const walk = async (p: unknown): Promise<void> => {
		const v = await p;
		if (!v) return;
		if (Array.isArray(v)) for (const x of v) await walk(x);
		else if (typeof v === 'object') out.push(v as { name?: string; api?: unknown });
	};
	await walk(option);
	return out;
}

/** Kit's options off its setup plugin: Kit 3's at the top of its config, Kit 2's under `kit`. */
async function kit_options_from_plugins(plugins: PluginOption): Promise<KitOptions | null> {
	const setup = (await flatten_plugins(plugins)).find((p) => p.name === 'vite-plugin-sveltekit-setup');
	const options = (setup?.api as { options?: KitOptions & { kit?: KitOptions } } | undefined)?.options;
	if (!options) return null;
	return options.kit ?? options;
}

/** Kit's options from a Kit 2 app's `svelte.config.js` (null when there is none). */
async function kit_options_from_file(root: string): Promise<KitOptions | null> {
	const file = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => existsSync(f));
	if (!file) return null;
	try {
		const mod = (await import(pathToFileURL(file).href)) as { default?: { kit?: KitOptions } };
		return mod.default?.kit ?? {};
	} catch (e) {
		console.warn(
			`[ogygia] could not read ${path.relative(root, file)} for kit.files.routes / kit.outDir — using the defaults (${DEFAULT_KIT_DIRS.routes}, ${DEFAULT_KIT_DIRS.out}). ${e instanceof Error ? e.message : String(e)}`
		);
		return null;
	}
}

/** Resolve `{ routes_dir, out_dir }` for `root` from its Kit config (defaults when absent or
 *  unreadable) and cache it for the compiler. `plugins`: the Vite config's plugin list. */
export async function load_kit_dirs(root: string, plugins?: PluginOption): Promise<KitDirs> {
	const kit: KitOptions = (await kit_options_from_plugins(plugins)) ?? (await kit_options_from_file(root)) ?? {};
	const dirs: KitDirs = {
		routes_dir: path.resolve(root, kit.files?.routes ?? DEFAULT_KIT_DIRS.routes),
		out_dir: path.resolve(root, kit.outDir ?? DEFAULT_KIT_DIRS.out)
	};
	set_kit_dirs(root, dirs);
	// `inlineStyleThreshold` — the same number governs ogygia's region CSS (compiler/kit.ts).
	const threshold = kit.inlineStyleThreshold;
	set_kit_inline_style_threshold(
		root,
		typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0 ? threshold : 0
	);
	return dirs;
}
