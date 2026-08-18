/**
 * The `import.meta.og.*` lexer — one hand-rolled scanner shared by every compile construct
 * (`loader.*`, `code`, `md`, `regions`, `bake`, …). It finds `import.meta.og.<path>(…)` CALLS in a
 * module's source without a full parse: a single left-to-right pass that skips strings, comments, and
 * regex literals, so a marker inside a doc comment or a string is never mistaken for a call.
 *
 * Why not an AST? These rewrites run in the Vite `transform` hook on EVERY module (svelte/ts/js) —
 * a parse per module per construct is the tax we refuse. The scanner is O(n), allocation-light, and
 * (critically) survives partial/invalid syntax mid-edit in dev. The git loader proved it; this is
 * that scanner, generalized so all constructs share one code path.
 */

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
			while (i + 1 < src.length && /[a-z]/i.test(src[i + 1]!)) i++; // regex flags
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
		if (!/\s/.test(c)) prev = c;
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
			while (i + 1 < src.length && /[a-z]/i.test(src[i + 1]!)) i++;
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
			while (q < src.length && /\s/.test(src[q]!)) q++;
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
		if (!/\s/.test(c)) prev = c;
	}
	return calls;
}

/** Split a call's argument text into the first string-literal (unquoted) and the verbatim rest.
 *  Throws (with `who` in the message) when the first argument is not a STATIC string literal — a
 *  bare identifier, or a template literal with `${…}` interpolation (not build-determinable). */
export function split_first_string(args: string, who: string): { value: string; rest: string } {
	let i = 0;
	while (i < args.length && /\s/.test(args[i]!)) i++;
	const q = args[i];
	if (q !== "'" && q !== '"' && q !== '`') {
		throw new Error(`[ogygia] ${who}: the first argument must be a static string literal, got '${args.slice(0, 24)}…'`);
	}
	let j = i + 1;
	for (; j < args.length; j++) {
		if (args[j] === '\\') j++;
		else if (args[j] === q) break;
	}
	const value = args.slice(i + 1, j);
	// A template literal with interpolation is a runtime value, not a build-time literal.
	if (q === '`' && /\$\{/.test(value)) {
		throw new Error(
			`[ogygia] ${who}: the first argument must be a static string literal — a template literal with \${…} interpolation is a runtime value the build cannot resolve.`
		);
	}
	let k = j + 1;
	while (k < args.length && /\s/.test(args[k]!)) k++;
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
