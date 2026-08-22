/**
 * Svelte-compile transform for the REPL bundler — compiles any `.svelte` module (workspace files AND
 * CDN sources) to client JS, so a component library that ships `.svelte` SOURCE (radix-svelte, bits-ui,
 * most `svelte-package` output) bundles from jsdelivr. Runs alongside {@link ./cdn-plugin.ts}: the CDN
 * plugin fetches `root.svelte`'s text, this compiles it, rolldown links it — with `svelte/internal/*`
 * external so every component shares the host's runtime.
 *
 * For the app's OWN files the ogygia host transform runs first (islands); this plugin is the plain
 * svelte-compile leg used for CDN packages + the live (whole-app) preview.
 */
import { compile } from 'svelte/compiler';

const SVELTE_MODULE = /\.svelte(?:\?|$)/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RolldownPlugin = any;

export interface SveltePluginOptions {
	/** `'client'` (mount/hydrate) or `'server'` (SSR). Defaults to client. */
	generate?: 'client' | 'server';
	/** Pre-process a `.svelte` source before compile (e.g. strip ogygia `with { … }` dials). */
	preprocess?: (code: string, id: string) => string;
}

export function sveltePlugin(opts: SveltePluginOptions = {}): RolldownPlugin {
	const generate = opts.generate ?? 'client';
	return {
		name: 'svelte-compile',
		transform(code: string, id: string) {
			if (!SVELTE_MODULE.test(id)) return null;
			const src = opts.preprocess ? opts.preprocess(code, id) : code;
			// dev:false — no `$.FILENAME` module-scope self-reference (our eval linker can't satisfy it).
			const { js } = compile(src, {
				filename: id.split('/').pop() || id,
				generate,
				dev: false
			}) as { js: { code: string; map: unknown } };
			return { code: js.code, map: js.map ?? null };
		}
	};
}
