// Shared, lazily-loaded prettier for the Observatory (the Format button + every readonly output). The
// formatter + its Svelte/TS/HTML/CSS plugins are big, so they're dynamic-imported once and cached —
// warmed on hover, fetched on first real use. oxfmt has no browser build; prettier/standalone is the
// client-side path.
type PrettierBundle = { format: (src: string, opts: Record<string, unknown>) => Promise<string>; plugins: unknown[] };

// prettier/standalone (prebundled for the browser) initialises a config-file loader with
// `createRequire(import.meta.url)`. The dep optimizer (Rolldown) resolves `node:module` to a browser-
// external stub whose `createRequire` is undefined, so that fire-and-forget init rejects with
// "createRequire is not a function". It's BENIGN — the Observatory always formats with EXPLICIT plugins,
// never touching config resolution — and it can't be shimmed at the optimizer (Rolldown ignores optimize-
// pass plugins AND `resolve.alias` for `node:` builtins; verified). Installed once when this module loads
// (before prettier is ever imported), it swallows exactly that one rejection; everything else propagates.
if (typeof window !== 'undefined') {
	window.addEventListener('unhandledrejection', (e) => {
		const reason = (e as PromiseRejectionEvent).reason;
		const msg = (reason && (reason.message ?? String(reason))) || '';
		// The thrown expression is `(0, x.createRequire)(…)`, so the message reads
		// "…createRequire) is not a function" — match both tokens rather than an exact phrase.
		if (msg.includes('createRequire') && msg.includes('is not a function')) e.preventDefault();
	});
}

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
