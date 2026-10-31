import type { UserConfig } from 'tsdown';
import { svelte, type SvelteOptions } from '@ogygia/tsdown-plugin-svelte';

/** Imports a package never bundles: the app installs its own copy of each. */
const SHARED: (string | RegExp)[] = [
	/^ogygia(\/|$)/,
	/^@ogygia\//,
	'svelte',
	/^svelte\//,
	/^@sveltejs\/kit(\/|$)/,
	'esm-env',
	/^node:/,
	/^virtual:/,
	/^\$app\//
];

export interface LibraryOptions extends Omit<UserConfig, 'entry' | 'deps'> {
	/** Source entries. Default: every `.ts` under `src`. */
	entry?: string[];
	/** More imports to leave as imports, beyond core, Svelte, Kit and node builtins. */
	external?: (string | RegExp)[];
	/** Options for the `.svelte` component pass (@ogygia/tsdown-plugin-svelte). */
	svelte?: SvelteOptions;
}

/**
 * The build every ogygia package shares: ESM, one output file per source file (the structure is
 * kept: a `/vite` entry must load in plain node, the rest is compiled again by the app's Vite),
 * `.d.ts` beside each, `.svelte` components shipped preprocessed with their `.svelte.d.ts`, and
 * core plus the app's own libraries left as imports.
 */
export function library(options: LibraryOptions = {}): UserConfig {
	const { entry = ['src/**/*.ts', '!src/**/*.d.ts'], external = [], svelte: svelte_options, plugins = [], ...rest } = options;
	return {
		entry,
		format: 'esm',
		platform: 'neutral',
		unbundle: true,
		dts: true,
		clean: true,
		...rest,
		plugins: [svelte(svelte_options), ...(Array.isArray(plugins) ? plugins : [plugins])],
		deps: { neverBundle: [...SHARED, ...external] }
	};
}
