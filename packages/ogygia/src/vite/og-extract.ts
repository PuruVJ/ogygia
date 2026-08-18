/**
 * Where `import.meta.og.*` constructs are recognized, and how each file type yields the JS to analyze.
 *
 * OWNERSHIP. At the Vite-transform layer this handles exactly two shapes — `.svelte` components and
 * JS/TS modules (`.ts`/`.js`/`.mjs`, which covers `.svelte.ts`/`.svelte.js`). Content files
 * (`.svx`/`.md`) are NOT here: they route through the markdown preprocessor (mdsvex → svelte), which
 * owns them — a construct inside a content file is the preprocessor's job, and it can reuse this same
 * extractor. The host set is still passed in (config-driven), so the one caller that owns markup can
 * decide which markup extensions count; the plugin passes `['.svelte']`.
 *
 * Per type the parse strategy differs — so detection stays AST-precise everywhere:
 *   • JS/TS module  → the WHOLE file is one JS region (offset 0).
 *   • `.svelte`     → each `<script>` / `<script module>` block is a JS region at its byte offset.
 * A construct in markup PROSE (not a `<script>`) is never a JS region — that's content, not code.
 */

/** A slice of JS/TS to analyze, plus where it starts in the original source (for offset mapping). */
export type JsRegion = { code: string; offset: number };

const JS_EXT = /\.(ts|js|mjs|cjs|mts|cts)$/;

/** Does `id` (a module path, maybe with a `?query`) end in a plain JS/TS extension? */
export function is_js_module(id: string): boolean {
	const clean = id.split('?')[0]!;
	return JS_EXT.test(clean);
}

/** Does `id` end in one of the configured MARKUP extensions (`.svelte`, `.svx`, `.md`)? */
export function is_markup_module(id: string, markup_exts: readonly string[]): boolean {
	const clean = id.split('?')[0]!;
	return markup_exts.some((ext) => clean.endsWith(ext));
}

/**
 * Extract the JS regions of a module for construct analysis. Returns `null` when the extension is not
 * a recognized construct host (the caller then leaves the file untouched). A JS/TS module is one
 * region; a markup file is its `<script>` blocks. `.svelte.ts`/`.svelte.js` hit the JS branch first
 * (they end in `.ts`/`.js`), so a `.svelte`-suffixed markup ext never shadows them.
 */
export function og_js_regions(src: string, id: string, markup_exts: readonly string[]): JsRegion[] | null {
	if (is_js_module(id)) return [{ code: src, offset: 0 }];
	if (is_markup_module(id, markup_exts)) return script_blocks(src);
	return null;
}

/**
 * Find every `<script …>…</script>` block and return its inner JS + byte offset. A single forward
 * scan (not a regex) so a `</script>` inside a JS string can't end a block early: we only close on a
 * `</script>` found while scanning raw text, and Svelte itself forbids an unescaped `</script>` in
 * script text, so this matches the compiler's own tokenization.
 */
function script_blocks(src: string): JsRegion[] {
	const regions: JsRegion[] = [];
	const lower = src.toLowerCase();
	let i = 0;
	for (;;) {
		const open = lower.indexOf('<script', i);
		if (open < 0) break;
		// End of the opening tag — the `>` that closes `<script …>`. Skip `>` inside attribute strings.
		const gt = tag_end(src, open);
		if (gt < 0) break;
		const close = lower.indexOf('</script>', gt + 1);
		if (close < 0) break;
		regions.push({ code: src.slice(gt + 1, close), offset: gt + 1 });
		i = close + '</script>'.length;
	}
	return regions;
}

/** Index of the `>` that ends the tag opened at `open`, honoring quoted attribute values. */
function tag_end(src: string, open: number): number {
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		if (c === '"' || c === "'") {
			for (i++; i < src.length && src[i] !== c; i++) {}
			continue;
		}
		if (c === '>') return i;
	}
	return -1;
}
