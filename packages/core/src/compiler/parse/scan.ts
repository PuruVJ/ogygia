/**
 * The string-aware macro SCANNER — the cheap-bailout front-end for `import.meta.og.*`.
 *
 * Two jobs, no full parse:
 *   • the LEXER (`find_og_calls` / `match_close` / `split_first_string`) locates
 *     `import.meta.og.<path>(…)` CALLS in a module's source with a single left-to-right pass that
 *     skips strings, comments, and regex literals, so a marker inside a doc comment or a string is
 *     never mistaken for a call.
 *   • the EXTRACTOR (`og_js_regions` / `is_js_module` / `is_markup_module`) decides where those
 *     constructs are recognized per file type, and yields the JS slices to analyze.
 *
 * Why not an AST? These rewrites run in the Vite `transform` hook on EVERY module (svelte/ts/js) —
 * a parse per module per construct is the tax we refuse. The scanner is O(n), allocation-light, and
 * (critically) survives partial/invalid syntax mid-edit in dev. The git loader proved it; this is
 * that scanner, generalized so all constructs share one code path.
 */

// ── regexes
const REGEX_FLAG_RE = /[a-z]/i;
const WS_RE = /\s/;
const TEMPLATE_INTERPOLATION_RE = /\$\{/;

// ─────────────────────────────────────────────────────────────────────────────
// LEXER — one hand-rolled scanner shared by every compile construct.
// ─────────────────────────────────────────────────────────────────────────────

/** A `/` begins a regex (not division) when the previous significant char is an operator/opener —
 *  always the case for a regex option value (`{ page: /…/ }`, `[/…/, /…/]`). */
export function regex_context(prev: string): boolean {
	return prev === '' || '([{,;:=!&|?+-~^<>*%'.includes(prev);
}

/** Index of the `)` matching the `(` at `open`, skipping strings, comments, and regex literals
 *  (incl. `[…]` char classes, which may hold an unescaped `/`). -1 if unbalanced. */
export function match_close(src: string, open: number): number {
	let depth = 0;
	let prev = '';
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		const c2 = src[i + 1];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			for (i++; i < src.length; i++) {
				if (src[i] === '\\') i++;
				else if (src[i] === q) break;
			}
			prev = c;
			continue;
		}
		if (c === '/' && c2 === '/') {
			for (i += 2; i < src.length && src[i] !== '\n'; i++) {}
			continue;
		}
		if (c === '/' && c2 === '*') {
			for (i += 2; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) {}
			i++;
			continue;
		}
		if (c === '/' && regex_context(prev)) {
			let in_class = false;
			for (i++; i < src.length; i++) {
				const r = src[i]!;
				if (r === '\\') i++;
				else if (r === '[') in_class = true;
				else if (r === ']') in_class = false;
				else if (r === '/' && !in_class) break;
			}
			while (i + 1 < src.length && REGEX_FLAG_RE.test(src[i + 1]!)) i++; // regex flags
			prev = '/';
			continue;
		}
		if (c === '(' || c === '{' || c === '[') {
			depth++;
			prev = c;
			continue;
		}
		if (c === ')' || c === '}' || c === ']') {
			if (--depth === 0) return i;
			prev = c;
			continue;
		}
		if (!WS_RE.test(c)) prev = c;
	}
	return -1;
}

/** One located `import.meta.og.<method>(<args>)` call. `args` is the VERBATIM text between the
 *  parens; `method` is the dotted tail after the shared prefix (`loader.git`, `code`, `regions`). */
export type OgCall = { start: number; end: number; method: string; args: string };

const IDENT = /[A-Za-z0-9_$.]/;

/**
 * Find every `<prefix><method>(…)` call in `src`. `prefix` is the literal namespace head
 * (`import.meta.og.`); `method` is the dotted identifier chain that follows, up to the `(`. Skips
 * strings/comments/regex so a marker in prose is never a false hit. Pure.
 */
export function find_og_calls(src: string, prefix: string): OgCall[] {
	const calls: OgCall[] = [];
	const head = prefix[0]!;
	let prev = '';
	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;
		const c2 = src[i + 1];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			for (i++; i < src.length; i++) {
				if (src[i] === '\\') i++;
				else if (src[i] === q) break;
			}
			prev = c;
			continue;
		}
		if (c === '/' && c2 === '/') {
			for (i += 2; i < src.length && src[i] !== '\n'; i++) {}
			continue;
		}
		if (c === '/' && c2 === '*') {
			for (i += 2; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) {}
			i++;
			continue;
		}
		if (c === '/' && regex_context(prev)) {
			let in_class = false;
			for (i++; i < src.length; i++) {
				const r = src[i]!;
				if (r === '\\') i++;
				else if (r === '[') in_class = true;
				else if (r === ']') in_class = false;
				else if (r === '/' && !in_class) break;
			}
			while (i + 1 < src.length && REGEX_FLAG_RE.test(src[i + 1]!)) i++;
			prev = '/';
			continue;
		}
		// A marker in CODE context (strings/comments/regex already `continue`d above).
		if (c === head && src.startsWith(prefix, i)) {
			let p = i + prefix.length;
			const name_start = p;
			while (p < src.length && IDENT.test(src[p]!)) p++;
			const method = src.slice(name_start, p);
			let q = p;
			while (q < src.length && WS_RE.test(src[q]!)) q++;
			if (method && src[q] === '(') {
				const close = match_close(src, q);
				if (close >= 0) {
					calls.push({ start: i, end: close + 1, method, args: src.slice(q + 1, close) });
					i = close;
					prev = ')';
					continue;
				}
			}
			i = p - 1;
			prev = 't';
			continue;
		}
		if (!WS_RE.test(c)) prev = c;
	}
	return calls;
}

/** Split a call's argument text into the first string-literal (unquoted) and the verbatim rest.
 *  Throws (with `who` in the message) when the first argument is not a STATIC string literal — a
 *  bare identifier, or a template literal with `${…}` interpolation (not build-determinable). */
export function split_first_string(args: string, who: string): { value: string; rest: string } {
	let i = 0;
	while (i < args.length && WS_RE.test(args[i]!)) i++;
	const q = args[i];
	if (q !== "'" && q !== '"' && q !== '`') {
		throw new Error(
			`[ogygia] ${who}: the first argument must be a static string literal, got '${args.slice(0, 24)}…'`
		);
	}
	let j = i + 1;
	for (; j < args.length; j++) {
		if (args[j] === '\\') j++;
		else if (args[j] === q) break;
	}
	const value = args.slice(i + 1, j);
	// A template literal with interpolation is a runtime value, not a build-time literal.
	if (q === '`' && TEMPLATE_INTERPOLATION_RE.test(value)) {
		throw new Error(
			`[ogygia] ${who}: the first argument must be a static string literal — a template literal with \${…} interpolation is a runtime value the build cannot resolve.`
		);
	}
	let k = j + 1;
	while (k < args.length && WS_RE.test(args[k]!)) k++;
	// After the closing quote the ONLY things that may follow are `,` (the next argument) or the end.
	// Anything else means the string is part of a larger expression (`"./" + dir`, a tagged template,
	// a `.concat(…)` call) — a runtime value the build can't resolve. Fail loudly, don't mis-slice.
	if (k < args.length && args[k] !== ',') {
		throw new Error(
			`[ogygia] ${who}: the first argument must be a static string literal, but it is part of a larger expression (near '${args.slice(i, k + 8)}…'). Use one plain string.`
		);
	}
	if (args[k] === ',') k++;
	return { value, rest: args.slice(k).trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTOR — where constructs are recognized, and how each file type yields the JS to analyze.
//
// OWNERSHIP. At the Vite-transform layer this handles exactly two shapes — `.svelte` components and
// JS/TS modules (`.ts`/`.js`/`.mjs`, which covers `.svelte.ts`/`.svelte.js`). Content files
// (`.svx`/`.md`) are NOT here: they route through the markdown preprocessor (mdsvex → svelte), which
// owns them — a construct inside a content file is the preprocessor's job, and it can reuse this same
// extractor. The host set is still passed in (config-driven), so the one caller that owns markup can
// decide which markup extensions count; the plugin passes `['.svelte']`.
//
// Per type the parse strategy differs — so detection stays AST-precise everywhere:
//   • JS/TS module  → the WHOLE file is one JS region (offset 0).
//   • `.svelte`     → each `<script>` / `<script module>` block is a JS region at its byte offset.
// A construct in markup PROSE (not a `<script>`) is never a JS region — that's content, not code.
// ─────────────────────────────────────────────────────────────────────────────

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
export function og_js_regions(
	src: string,
	id: string,
	markup_exts: readonly string[]
): JsRegion[] | null {
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
