// Shared, lazily-loaded prettier for the Observatory (the Format button + every readonly output). The
// formatter + its Svelte/TS/HTML/CSS plugins are big, so they're dynamic-imported once and cached —
// warmed on hover, fetched on first real use. oxfmt has no browser build; prettier/standalone is the
// client-side path.
type PrettierBundle = { format: (src: string, opts: Record<string, unknown>) => Promise<string>; plugins: unknown[] };

let load: Promise<PrettierBundle> | null = null;

export function warmPrettier(): Promise<PrettierBundle> {
	if (load) return load;
	load = (async () => {
		const [core, svelte, estree, babel, ts, htmlp, postcss] = await Promise.all([
			import('prettier/standalone'),
			import('prettier-plugin-svelte'),
			import('prettier/plugins/estree'),
			import('prettier/plugins/babel'),
			import('prettier/plugins/typescript'),
			import('prettier/plugins/html'),
			import('prettier/plugins/postcss')
		]);
		return { format: core.format, plugins: [(svelte as { default?: unknown }).default ?? svelte, estree, babel, ts, htmlp, postcss] };
	})();
	return load;
}

export function parserFor(lang: string | undefined): string {
	const k = lang ?? '';
	if (k === 'svelte' || k.endsWith('.svelte')) return 'svelte';
	if (k === 'ts' || k.endsWith('.ts')) return 'typescript';
	if (k === 'js' || k.endsWith('.js') || k.endsWith('.mjs')) return 'babel';
	if (k === 'html' || k.endsWith('.html')) return 'html';
	return 'babel';
}

/** Format a source string. printWidth 60 (the panes are narrow), tabs, clean markup. Throws on syntax
 *  errors — callers keep the raw source. */
export async function formatCode(src: string, lang: string | undefined, opts: Record<string, unknown> = {}): Promise<string> {
	const { format, plugins } = await warmPrettier();
	return format(src, {
		parser: parserFor(lang),
		plugins,
		printWidth: 60,
		useTabs: true,
		singleQuote: true,
		svelteStrictMode: false,
		htmlWhitespaceSensitivity: 'ignore',
		...opts
	});
}
