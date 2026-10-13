/**
 * Kit's two configurable directories, read from the app's Kit config: `files.routes` (default
 * `src/routes`) and `outDir` (default `.svelte-kit`). ogygia scans the routes tree (csr worlds, the
 * client-build keepalive, route options) and writes/reads its island-deps handoff under Kit's output
 * dir — every one of those must follow the app's configuration, not the defaults (an app building
 * two route trees from one source, `PES_MODE=v2 → src/routes-v2` + `.svelte-kit-v2`, had its
 * all-csr=false tree read as "no routes": Kit skipped the client build, the runtime chunk was never
 * emitted, every island 404'd).
 *
 * WHERE THE CONFIG IS. Kit takes its config in the vite config only (`sveltekit({...})`), and its own
 * setup plugin carries it validated (`vite-plugin-sveltekit-setup`'s `api.options`).
 *
 * Loaded once per root in the plugin's `config` hook (before Kit reads the routes); the compiler
 * reads the cached answer through `kit_dirs(root)` in compiler/kit.ts. Node-only — that is why it
 * lives on the Vite side, not in the host-neutral compiler.
 */
import path from 'node:path';
import {
	set_kit_dirs,
	set_kit_inline_style_threshold,
	type KitDirs,
	DEFAULT_KIT_DIRS
} from '../compiler/kit.js';

type KitOptions = { files?: { routes?: string }; outDir?: string; inlineStyleThreshold?: number };

/** The plugin list as a Vite config holds it: plugins, arrays of them, promises of either, falsy. */
type PluginOption = unknown;

/** Every plugin in `option`, flattened (arrays nest; `sveltekit()` is a promise). */
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

/** Kit's options off its setup plugin, or null when there is none (a standalone compile). */
async function kit_options_from_plugins(plugins: PluginOption): Promise<KitOptions | null> {
	const setup = (await flatten_plugins(plugins)).find((p) => p.name === 'vite-plugin-sveltekit-setup');
	return (setup?.api as { options?: KitOptions } | undefined)?.options ?? null;
}

/** Resolve `{ routes_dir, out_dir }` for `root` from its Kit config (defaults when absent) and cache
 *  it for the compiler. `plugins`: the Vite config's plugin list. */
export async function load_kit_dirs(root: string, plugins?: PluginOption): Promise<KitDirs> {
	const kit: KitOptions = (await kit_options_from_plugins(plugins)) ?? {};
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
