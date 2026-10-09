/**
 * SOURCE SCAN — reading app code at report time, without regular expressions: a tokenizer, the
 * extent of a function's body, a module's import aliases, the lines that call a name, and the
 * names a wrapped function goes by. The line ledger (ledger.ts) and the pattern finder
 * (patterns.ts) both read code through these, only for the handful of lines a report names.
 */

/** lines `from`..`to` of a source (1-based, inclusive), untrimmed */
export type SourceReader = (
	path: string,
	from: number,
	to: number
) => { start: number; lines: string[] } | undefined;

const is_id_start = (c: number) =>
	(c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;
const is_id_part = (c: number) => is_id_start(c) || (c >= 48 && c <= 57);
const PUNCT2: ReadonlySet<string> = new Set([
	'=>',
	'+=',
	'?.',
	'&&',
	'||',
	'??',
	'==',
	'!=',
	'<=',
	'>=',
	'++',
	'--'
]);

/** One line of JS/TS as tokens: identifiers and keywords as they are, every string literal as
 *  `""`, every number as `0`, punctuation one token each (`...`, `=>`, `+=`, `?.` kept whole).
 *  Comments are dropped. A template literal is one string token followed by each `${…}` part's
 *  own tokens in parentheses (`\`t${i + k}\`` → `""`, `(`, `i`, `+`, `k`, `)`), so the code inside
 *  it is seen. */
export function tokens(line: string): string[] {
	const out: string[] = [];
	const n = line.length;
	let i = 0;
	while (i < n) {
		const c = line.charCodeAt(i);
		if (c === 32 || c === 9 || c === 13) {
			i++;
			continue;
		}
		if (c === 47 && line.charCodeAt(i + 1) === 47) break;
		if (c === 47 && line.charCodeAt(i + 1) === 42) {
			const e = line.indexOf('*/', i + 2);
			if (e < 0) break;
			i = e + 2;
			continue;
		}
		if (c === 34 || c === 39 || c === 96) {
			let j = i + 1;
			/** a template literal's `${…}` parts: code, tokenized after the string's own token */
			const parts: string[] = [];
			while (j < n) {
				const d = line.charCodeAt(j);
				if (d === 92) {
					j += 2;
					continue;
				}
				if (d === c) break;
				if (c === 96 && d === 36 && line.charCodeAt(j + 1) === 123) {
					// balance braces to the part's end (an object literal inside it nests)
					let depth = 1;
					let k = j + 2;
					while (k < n && depth > 0) {
						const e = line.charCodeAt(k);
						if (e === 123) depth++;
						else if (e === 125) depth--;
						if (depth > 0) k++;
					}
					parts.push(line.slice(j + 2, k));
					j = k + 1;
					continue;
				}
				j++;
			}
			out.push('""');
			for (const p of parts) out.push('(', ...tokens(p), ')');
			i = j + 1;
			continue;
		}
		if (is_id_start(c)) {
			let j = i + 1;
			while (j < n && is_id_part(line.charCodeAt(j))) j++;
			out.push(line.slice(i, j));
			i = j;
			continue;
		}
		if (c >= 48 && c <= 57) {
			let j = i + 1;
			while (j < n && (is_id_part(line.charCodeAt(j)) || line.charCodeAt(j) === 46)) j++;
			out.push('0');
			i = j;
			continue;
		}
		if (c === 46 && line.charCodeAt(i + 1) === 46 && line.charCodeAt(i + 2) === 46) {
			out.push('...');
			i += 3;
			continue;
		}
		const two = line.slice(i, i + 2);
		if (PUNCT2.has(two)) {
			out.push(two);
			i += 2;
			continue;
		}
		out.push(line[i]);
		i++;
	}
	return out;
}

/** The lines of a function from its first line to its closing brace (brace-balanced over tokens,
 *  so braces in strings and comments do not count); a braceless arrow is its one line. Capped. */
export function function_body(
	source: SourceReader,
	path: string,
	start: number,
	max = 400
): { start: number; lines: string[] } | undefined {
	const got = source(path, start, start + max);
	if (!got) return undefined;
	let depth = 0;
	let opened = false;
	for (let i = 0; i < got.lines.length; i++) {
		for (const t of tokens(got.lines[i])) {
			if (t === '{') {
				depth++;
				opened = true;
			} else if (t === '}') depth--;
		}
		if (opened && depth <= 0) return { start: got.start, lines: got.lines.slice(0, i + 1) };
		// `(x) => expr` with no block on its first line: the function is that line
		if (!opened && i === 0 && got.lines[0].includes('=>'))
			return { start: got.start, lines: got.lines.slice(0, 1) };
	}
	return got;
}

/** the first lines of a file, where its imports and top-level wrappers sit */
const HEAD_LINES = 400;

/** A module's import aliases: `import { renderToString as render } from 'x'` → renderToString → [render]. */
export function import_aliases(source: SourceReader, path: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const head = source(path, 1, HEAD_LINES);
	if (!head) return out;
	let inside = false;
	for (const line of head.lines) {
		const t = tokens(line);
		for (let k = 0; k < t.length; k++) {
			if (t[k] === 'import') inside = true;
			else if (t[k] === 'from' || t[k] === ';') inside = false;
			else if (inside && t[k] === 'as' && t[k - 1] && t[k + 1] && t[k - 1] !== '*')
				push(out, t[k - 1], t[k + 1]);
		}
	}
	return out;
}

/** The names a function also goes by in its module when it is WRAPPED:
 *  `const renderToString = instrument(render, 'ds.render')` → render → [renderToString].
 *  The shape is `const|let|var X = <call chain>(name` — the function is the wrapper's first argument. */
export function wrapper_aliases(source: SourceReader, path: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const head = source(path, 1, HEAD_LINES);
	if (!head) return out;
	for (const line of head.lines) {
		const t = tokens(line);
		for (let k = 0; k + 3 < t.length; k++) {
			if ((t[k] !== 'const' && t[k] !== 'let' && t[k] !== 'var') || t[k + 2] !== '=') continue;
			// walk the callee (`instrument`, `lib.wrap`, `memo(opts)`…) to its first `(`
			let j = k + 3;
			while (
				j < t.length &&
				(t[j] === '.' || (t[j] !== '(' && t[j] !== ')' && is_id_start(t[j].charCodeAt(0))))
			)
				j++;
			if (j === k + 3 || t[j] !== '(' || !t[j + 1] || !is_id_start(t[j + 1].charCodeAt(0)))
				continue;
			if (t[j + 2] !== ',' && t[j + 2] !== ')') continue;
			push(out, t[j + 1], t[k + 1]);
		}
	}
	return out;
}

/** how V8 names a compiled regular expression's code in a CPU profile: `RegExp: ^(\w+\s?)*$` */
export const REGEXP_FRAME = 'RegExp: ';

/**
 * CAN THIS PATTERN BACKTRACK HARD? A repeated group that itself repeats something (`(\w+\s?)*`,
 * `(a+)+`, `(?:x*y?)+`): the engine can split the same text many ways and tries them all before a
 * match fails. (A repeated choice, `(a|aa)+`, can too, but `(foo|bar)+` is the usual one and
 * harmless: not claimed.) A character scan, not a parse: escapes and classes are skipped over.
 */
export function backtracks(source: string | undefined): boolean {
	if (!source) return false;
	/** what follows an atom at `i`: `'many'` (`*`, `+`, `{n,}`), `'maybe'` (`?`, `{0,1}`-ish), or
	 *  `'once'` (none, or a fixed `{n}`) */
	const after = (i: number): 'many' | 'maybe' | 'once' => {
		const c = source[i];
		if (c === '*' || c === '+') return 'many';
		if (c === '?') return 'maybe';
		if (c === '{') {
			const close = source.indexOf('}', i);
			const comma = source.indexOf(',', i);
			if (close !== -1 && comma !== -1 && comma < close) return 'many';
		}
		return 'once';
	};
	// per open group: something inside repeats; something inside must match exactly once (a fixed
	// part each repeat has to consume — `\s` in `(\s\w+)*` — pins where one repeat ends); a choice
	type Group = { repeats: boolean; fixed: boolean; choice: boolean };
	const stack: Group[] = [{ repeats: false, fixed: false, choice: false }];
	const top = () => stack[stack.length - 1];
	const atom = (q: 'many' | 'maybe' | 'once') => {
		if (q === 'many') top().repeats = true;
		else if (q === 'once') top().fixed = true;
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			i++;
			atom(after(i + 1));
			continue;
		}
		if (c === '[') {
			// a character class: to its closing bracket
			for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
			atom(after(i + 1));
			continue;
		}
		if (c === '(') {
			stack.push({ repeats: false, fixed: false, choice: false });
			// `(?:`, `(?=`, `(?<name>`: the group's own marker is not an atom
			if (source[i + 1] === '?') {
				i++;
				if (source[i + 1] === '<' && source[i + 2] !== '=' && source[i + 2] !== '!') {
					const end = source.indexOf('>', i);
					if (end !== -1) i = end;
				} else i++;
			}
			continue;
		}
		if (c === ')') {
			if (stack.length < 2) continue;
			const g = stack.pop()!;
			const q = after(i + 1);
			// A REPEATED GROUP WHOSE INSIDE CAN SPLIT THE TEXT MANY WAYS: it repeats something and
			// has no fixed part to pin where one repeat ends
			if (q === 'many' && g.repeats && !g.fixed && !g.choice) return true;
			if (q === 'many' || g.repeats) top().repeats = true;
			if (q === 'once' && g.fixed) top().fixed = true;
			continue;
		}
		if (c === '|') {
			top().choice = true;
			continue;
		}
		// a count (`{2,}`): its digits are not atoms
		if (c === '{') {
			const close = source.indexOf('}', i);
			if (close !== -1) i = close;
			continue;
		}
		if (c === '^' || c === '$' || c === '*' || c === '+' || c === '?' || c === '}') continue;
		atom(after(i + 1));
	}
	return false;
}

/**
 * THE REGEX LITERALS WRITTEN ON A LINE (their source, without the slashes and flags): a `/` where
 * an expression starts (after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`, `return`, or
 * at the start) opens one. Strings, template text and comments are skipped; a division is not a
 * literal (it follows a value).
 */
export function regex_literals(code: string): string[] {
	const out: string[] = [];
	let prev = ''; // the last non-space character outside strings
	let word = ''; // the identifier just before, for `return /x/`
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
			prev = c;
			word = '';
			continue;
		}
		if (c === '/' && code[i + 1] === '/') break;
		if (c === '/' && code[i + 1] === '*') {
			const end = code.indexOf('*/', i + 2);
			if (end === -1) break;
			i = end + 1;
			continue;
		}
		if (c === '/') {
			const starts = prev === '' || '(,=:[!&|?{};'.includes(prev) || word === 'return';
			if (starts) {
				let j = i + 1;
				let in_class = false;
				for (; j < code.length; j++) {
					const d = code[j];
					if (d === '\\') {
						j++;
						continue;
					}
					if (d === '[') in_class = true;
					else if (d === ']') in_class = false;
					else if (d === '/' && !in_class) break;
				}
				if (j < code.length && j > i + 1) {
					out.push(code.slice(i + 1, j));
					i = j;
					while (i + 1 < code.length && ID_CHAR(code[i + 1])) i++;
					prev = ')';
					word = '';
					continue;
				}
			}
		}
		if (c === ' ' || c === '\t') continue;
		word = ID_CHAR(c) ? (ID_CHAR(prev) ? word + c : c) : '';
		prev = c;
	}
	return out;
}
const ID_CHAR = (c: string | undefined) =>
	!!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$');

/** does this line call `name(` (plain or as a method), outside strings and comments? */
export function calls_name(line: string, names: readonly string[]): boolean {
	const t = tokens(line);
	for (let k = 0; k + 1 < t.length; k++)
		if (t[k + 1] === '(' && names.includes(t[k]) && t[k - 1] !== 'function') return true;
	return false;
}

/** The functions a hooks file's `handle` is made of, when they live in OTHER app modules:
 *  `export const handle = sequence(ds_ssr, auth)` with `import { ds_ssr } from '$lib/ds-ssr'` →
 *  ds_ssr → `ds-ssr`. The value is the module's file stem, so a CPU frame counts as that handle
 *  only when it is named so AND sits in that file. A handle written in the hooks file itself is
 *  not listed (its frames are in the hooks file already), and neither is one from a package (a
 *  library's frames say what they are) or one made by a call (`auth()`: what it returns has its
 *  own name). */
export function handle_parts(source: SourceReader, path: string): Map<string, string> {
	const out = new Map<string, string>();
	const text = source(path, 1, 2000);
	if (!text) return out;
	/** local name → the name it was exported under and the module's file stem */
	const imported = new Map<string, { name: string; stem: string }>();
	let pending: [string, string][] = [];
	let inside = false;
	const all: string[] = [];
	for (const line of text.lines) {
		const t = tokens(line);
		for (let k = 0; k < t.length; k++) {
			const w = t[k];
			if (w === 'import' && (k === 0 || t[k - 1] === ';')) {
				inside = true;
				pending = [];
			} else if (inside && w === 'from') {
				const stem = app_module_stem(spec_after_from(line));
				if (stem) for (const [name, local] of pending) imported.set(local, { name, stem });
				inside = false;
			} else if (inside && w === 'type') {
				k++; // `type Handle`: a type, not a value
			} else if (inside && is_id_start(w.charCodeAt(0)) && w !== 'as') {
				if (t[k + 1] === 'as' && t[k + 2]) {
					pending.push([w, t[k + 2]]);
					k += 2;
				} else pending.push([w, w]);
			}
		}
		for (const w of t) all.push(w);
	}
	for (let k = 0; k + 3 < all.length; k++) {
		if (
			all[k] !== 'export' ||
			(all[k + 1] !== 'const' && all[k + 1] !== 'let') ||
			all[k + 2] !== 'handle'
		)
			continue;
		// past a type annotation (`handle: Handle =`) to the value
		let j = k + 3;
		while (j < all.length && all[j] !== '=') j++;
		j++;
		const take = (name: string) => {
			const hit = imported.get(name);
			if (hit) out.set(hit.name, hit.stem);
		};
		if (all[j + 1] !== '(') {
			take(all[j]);
			break;
		}
		// `sequence(a, b(), c)`: the bare names at the call's own depth
		let depth = 0;
		for (let i = j + 1; i < all.length; i++) {
			const w = all[i];
			if (w === '(' || w === '[' || w === '{') depth++;
			else if (w === ')' || w === ']' || w === '}') {
				if (--depth === 0) break;
			} else if (
				depth === 1 &&
				(all[i - 1] === '(' || all[i - 1] === ',') &&
				(all[i + 1] === ',' || all[i + 1] === ')')
			)
				take(w);
		}
		break;
	}
	return out;
}

/** the quoted module specifier after the last `from` on a line (`''` when there is none) */
function spec_after_from(line: string): string {
	const at = line.lastIndexOf('from');
	if (at === -1) return '';
	let i = at + 4;
	while (i < line.length && line[i] !== "'" && line[i] !== '"') i++;
	const end = line.indexOf(line[i], i + 1);
	return end === -1 ? '' : line.slice(i + 1, end);
}

/** an app module's file stem (`$lib/hell/ds-ssr` → `ds-ssr`, `./auth.js` → `auth`); undefined for
 *  a package (`@sveltejs/kit/hooks`, `ogygia/server`) */
function app_module_stem(spec: string): string | undefined {
	const c = spec[0];
	if (c !== '.' && c !== '/' && c !== '$' && c !== '~' && c !== '#') return undefined;
	const leaf = spec.slice(spec.lastIndexOf('/') + 1);
	const dot = leaf.indexOf('.');
	const stem = dot === -1 ? leaf : leaf.slice(0, dot);
	return stem && stem !== 'index' ? stem : undefined;
}

function push(m: Map<string, string[]>, k: string, v: string) {
	const list = m.get(k);
	if (!list) m.set(k, [v]);
	else if (!list.includes(v)) list.push(v);
}

/** a word that is not a variable: the language's own, and the ones a statement reads by */
const NOT_A_NAME: ReadonlySet<string> = new Set([
	'await',
	'async',
	'return',
	'const',
	'let',
	'var',
	'new',
	'typeof',
	'instanceof',
	'in',
	'of',
	'if',
	'else',
	'for',
	'while',
	'do',
	'function',
	'true',
	'false',
	'null',
	'undefined',
	'this',
	'as',
	'satisfies',
	'void',
	'delete',
	'yield',
	'throw',
	'try',
	'catch',
	'finally',
	'switch',
	'case',
	'break',
	'continue',
	'default',
	'class',
	'extends',
	'super',
	'import',
	'export'
]);
/** a method that fills the value it is called on: `list.push(x)` writes `list` */
const FILLS: ReadonlySet<string> = new Set(['push', 'unshift', 'set', 'add', 'splice', 'assign']);

/**
 * WHERE EACH RETURNED KEY COMES FROM: the lines of a `load` whose values end up in each key of its
 * `return { … }` — a key's expression, the variables it reads, the lines that declare or fill those
 * (`const live = await fetch(…)`, `stock.push(await stockOf(…))`), and so on back through what they
 * read. 1-based line numbers of `source`. A wait made on one of a key's lines is a wait for that
 * key. Tokens only (no regex); null when there is no `load` or its return is not an object literal.
 */
/**
 * WHERE A FILE'S `load` IS: its `export` line, and the lines its block body opens and closes on
 * (0-based). `export async function load(…): Promise<{ a: string }> {` — the return type's braces
 * are skipped; `export const load = async (…) => {` — the block after its arrow (a `satisfies`
 * wrapper around it too). An expression body (`=> ({ … })`) has no block: null, never the next
 * function in the file.
 */
export function load_span(
	T: readonly (readonly string[])[]
): { head: number; body0: number; body1: number } | null {
	let head = -1;
	let is_fn = false;
	for (let i = 0; i < T.length && head < 0; i++) {
		const t = T[i];
		if (t[0] !== 'export') continue;
		for (let k = 1; k + 1 < t.length; k++)
			if (t[k + 1] === 'load' && (t[k] === 'const' || t[k] === 'function')) {
				head = i;
				is_fn = t[k] === 'function';
			}
	}
	if (head < 0) return null;
	// the tokens from the head on, each with its line
	const flat: { t: string; line: number }[] = [];
	for (let i = head; i < T.length; i++) for (const t of T[i]) flat.push({ t, line: i });
	let k = flat.findIndex((x) => x.t === 'load');
	let open = -1;
	if (is_fn) {
		// the parameter list, then past a return type: `<…>` and a type literal's `{…}` are the type's
		while (k < flat.length && flat[k].t !== '(') k++;
		let paren = 0;
		for (; k < flat.length; k++) {
			if (flat[k].t === '(') paren++;
			else if (flat[k].t === ')' && --paren === 0) break;
		}
		let angle = 0;
		for (k++; k < flat.length && open < 0; k++) {
			const x = flat[k].t;
			const prev = flat[k - 1].t;
			if (x === '<') angle++;
			else if (x === '>') angle--;
			else if (x === '{' && angle === 0) {
				if (prev === ':' || prev === '|' || prev === '&' || prev === '(') {
					// a type literal: skip it whole
					let d = 0;
					for (; k < flat.length; k++) {
						if (flat[k].t === '{') d++;
						else if (flat[k].t === '}' && --d === 0) break;
					}
				} else open = k;
			}
		}
	} else {
		// the arrow's block: the first `=>` after the head, then `{` right after it (else no block)
		while (k < flat.length && flat[k].t !== '=>') k++;
		if (k + 1 < flat.length && flat[k + 1].t === '{') open = k + 1;
	}
	if (open < 0) return null;
	let d = 0;
	for (let j = open; j < flat.length; j++) {
		if (flat[j].t === '{') d++;
		else if (flat[j].t === '}' && --d === 0)
			return { head, body0: flat[open].line, body1: flat[j].line };
	}
	return null;
}

export function key_sources(source: string): Map<string, number[]> | null {
	const lines = source.split('\n');
	const T = lines.map((l) => tokens(l));
	const span = load_span(T);
	if (!span) return null;
	const { body0, body1 } = span;
	/** `decl`: each declaration's own lines (a name declared in two callbacks is two locals) */
	type Name = { lines: Set<number>; deps: Set<string>; decl: Set<number>[] };
	const names = new Map<string, Name>();
	const name_of = (n: string) =>
		names.get(n) ?? names.set(n, { lines: new Set(), deps: new Set(), decl: [] }).get(n)!;
	/** the variables a stretch of tokens reads — not a property (`x.p`), and not a callback's own
	 *  parameter (`(p) => …`, `p => …`: a local, whatever else is called `p`) */
	const ids = (list: readonly string[]) => {
		const params = new Set<string>();
		for (let m = 0; m < list.length; m++) {
			if (list[m] !== '=>') continue;
			if (list[m - 1] !== ')') {
				if (list[m - 1]) params.add(list[m - 1]);
				continue;
			}
			let d = 0;
			for (let j = m - 1; j >= 0; j--) {
				if (list[j] === ')') d++;
				else if (list[j] === '(' && --d === 0) break;
				else if (d >= 1 && is_id_start(list[j].charCodeAt(0)) && list[j - 1] !== ':')
					params.add(list[j]);
			}
		}
		return list.filter(
			(t, k) =>
				is_id_start(t.charCodeAt(0)) &&
				!NOT_A_NAME.has(t) &&
				!params.has(t) &&
				list[k - 1] !== '.' &&
				list[k - 1] !== '?.'
		);
	};
	// declarations: `const a = …`, `const { a, b: c } = …`, `const [a, b] = …`, `for (const p of xs)`,
	// the statement running on while its brackets are open
	for (let i = body0; i <= body1; i++) {
		const t = T[i];
		for (let k = 0; k < t.length; k++) {
			if (t[k] !== 'const' && t[k] !== 'let' && t[k] !== 'var') continue;
			const declared: string[] = [];
			let j = k + 1;
			let depth = 0;
			let typed = false;
			for (; j < t.length; j++) {
				const x = t[j];
				if (depth === 0 && (x === '=' || x === 'of' || x === 'in')) break;
				if (x === '{' || x === '[' || x === '(' || x === '<') depth++;
				else if (x === '}' || x === ']' || x === ')' || x === '>') depth--;
				else if (x === ':' && depth === 0) typed = true;
				// `a: b` inside a pattern renames (b is the name); `a: Type` at the top types a
				else if (
					!typed &&
					is_id_start(x.charCodeAt(0)) &&
					!NOT_A_NAME.has(x) &&
					(depth === 0 || t[j + 1] !== ':')
				)
					declared.push(x);
			}
			if (!declared.length) continue;
			// `let user;` — declared with no value: known now, so the lines that assign it later count
			if (j >= t.length) {
				for (const d of declared) {
					const n = name_of(d);
					n.decl.push(new Set([i + 1]));
					n.lines.add(i + 1);
				}
				break;
			}
			// the right side, over the lines its brackets stay open
			const rhs: string[] = t.slice(j + 1);
			const at = new Set<number>([i + 1]);
			let open = 0;
			for (const x of rhs)
				open +=
					x === '(' || x === '[' || x === '{' ? 1 : x === ')' || x === ']' || x === '}' ? -1 : 0;
			for (let m = i + 1; open > 0 && m <= body1; m++) {
				at.add(m + 1);
				for (const x of T[m]) {
					rhs.push(x);
					open +=
						x === '(' || x === '[' || x === '{' ? 1 : x === ')' || x === ']' || x === '}' ? -1 : 0;
				}
			}
			const deps = ids(rhs);
			for (const d of declared) {
				const n = name_of(d);
				n.decl.push(at);
				for (const l of at) n.lines.add(l);
				for (const x of deps) if (x !== d) n.deps.add(x);
			}
			break;
		}
	}
	// writes: `xs.push(…)`, `x = …`, `x += …` on a line fill `x` with what that line reads
	for (let i = body0; i <= body1; i++) {
		const t = T[i];
		for (let k = 0; k < t.length; k++) {
			const n = names.get(t[k]);
			if (!n || t[k - 1] === '.' || t[k - 1] === '?.') continue;
			const fills = t[k + 1] === '.' && FILLS.has(t[k + 2]) && t[k + 3] === '(';
			// `x = …`, `x += …`, `x[k] = …`, `x.k = …` at a statement's start
			let after = k + 1;
			if (t[after] === '[') {
				let d = 0;
				for (; after < t.length; after++)
					if (t[after] === '[') d++;
					else if (t[after] === ']' && --d === 0) break;
				after++;
			} else if (t[after] === '.' && t[after + 2] === '=') after += 2;
			const assigns =
				(t[after] === '=' || t[after] === '+=') &&
				(k === 0 ||
					t[k - 1] === ';' ||
					t[k - 1] === '{' ||
					t[k - 1] === ')' ||
					t[k - 1] === 'else');
			if (!fills && !assigns) continue;
			n.lines.add(i + 1);
			for (const x of ids(t)) if (x !== t[k]) n.deps.add(x);
		}
	}
	// a name declared INSIDE another's statement (`const res` in a callback) is that statement's local:
	// its lines are already there, and another local of the same name elsewhere is not a dependency
	for (const n of names.values()) {
		for (const d of [...n.deps]) {
			const dn = names.get(d);
			if (dn?.decl.some((set) => [...set].every((l) => n.lines.has(l)))) n.deps.delete(d);
		}
	}
	// the last `return {` at the body's own level: its keys and what each one's expression reads
	let ret = -1;
	{
		let depth = 0;
		for (let i = body0; i <= body1; i++) {
			const t = T[i];
			for (let k = 0; k < t.length; k++) {
				if (t[k] === '{') depth++;
				else if (t[k] === '}') depth--;
				else if (
					t[k] === 'return' &&
					depth === 1 &&
					(t[k + 1] === '{' || (t[k + 1] === '(' && t[k + 2] === '{'))
				)
					ret = i;
			}
		}
	}
	if (ret < 0) return null;
	const flat: { t: string; line: number }[] = [];
	for (let i = ret; i <= body1; i++) for (const t of T[i]) flat.push({ t, line: i + 1 });
	let s = flat.findIndex((x) => x.t === 'return');
	while (s < flat.length && flat[s].t !== '{') s++;
	const keys = new Map<string, { reads: string[]; lines: Set<number>; toks: string[] }>();
	{
		let depth = 0;
		let key: string | null = null;
		let expect_key = true;
		for (let i = s; i < flat.length; i++) {
			const x = flat[i].t;
			if (x === '{' || x === '[' || x === '(') {
				depth++;
				if (depth === 1) continue;
			} else if (x === '}' || x === ']' || x === ')') {
				depth--;
				if (depth === 0) break;
			}
			if (depth === 1 && x === ',') {
				key = null;
				expect_key = true;
				continue;
			}
			if (depth === 1 && expect_key) {
				expect_key = false;
				if (x === '...') continue;
				if (!is_id_start(x.charCodeAt(0))) continue;
				key = x;
				const entry = {
					reads: [] as string[],
					lines: new Set<number>([flat[i].line]),
					toks: [] as string[]
				};
				keys.set(x, entry);
				// shorthand `{ term, … }`: the value is the variable of that name
				const next = flat[i + 1]?.t;
				if (next === ',' || next === '}') entry.reads.push(x);
				continue;
			}
			if (key && x !== ':') {
				const k = keys.get(key)!;
				k.lines.add(flat[i].line);
				k.toks.push(x);
			}
		}
	}
	if (!keys.size) return null;
	// what each value reads, by the same rule as a declaration's right side
	for (const k of keys.values()) k.reads.push(...ids(k.toks));
	// the file's own helpers (`function currentUser(…) {`, `const svc = async (…) => {`) and their
	// lines: a key whose line calls one owns the helper's body too (a wait made in there, where the
	// stack no longer reaches the load after an await, is still for that key), helper to helper
	const helpers = new Map<string, number[]>();
	for (let i = 0; i < T.length; i++) {
		if (i >= body0 && i <= body1) continue;
		const t = T[i];
		const f = t.indexOf('function');
		const c = t.indexOf('const');
		const name =
			f !== -1 && is_id_start((t[f + 1] ?? '').charCodeAt(0))
				? t[f + 1]
				: c !== -1 && t[c + 2] === '=' && t.includes('=>')
					? t[c + 1]
					: undefined;
		if (!name || name === 'load') continue;
		let depth = 0;
		let opened = false;
		const span: number[] = [];
		for (let j = i; j < T.length; j++) {
			span.push(j + 1);
			for (const x of T[j]) {
				if (x === '{') (depth++, (opened = true));
				else if (x === '}') depth--;
			}
			if ((opened && depth <= 0) || (!opened && j === i)) break;
		}
		helpers.set(name, span);
	}
	const calls_on = (line: number) =>
		T[line - 1]?.filter((x, k, t) => helpers.has(x) && t[k + 1] === '(') ?? [];
	const out = new Map<string, number[]>();
	for (const [key, k] of keys) {
		const lines_of = new Set<number>(k.lines);
		const seen = new Set<string>();
		const stack = [...k.reads];
		while (stack.length) {
			const n = stack.pop()!;
			if (seen.has(n)) continue;
			seen.add(n);
			const d = names.get(n);
			if (!d) continue;
			for (const l of d.lines) lines_of.add(l);
			for (const x of d.deps) stack.push(x);
		}
		// helpers called from its lines, and helpers those call
		const todo = [...lines_of];
		const took = new Set<string>();
		while (todo.length) {
			for (const h of calls_on(todo.pop()!)) {
				if (took.has(h)) continue;
				took.add(h);
				for (const l of helpers.get(h)!) if (!lines_of.has(l)) (lines_of.add(l), todo.push(l));
			}
		}
		out.set(
			key,
			[...lines_of].sort((a, b) => a - b)
		);
	}
	return out;
}

/** One line's reads and writes: the names it declares or assigns (`const a =`, `a =`, `a += `,
 *  `a[k] =`), the receivers it fills (`list.push(…)`), and the variables it reads (not a property,
 *  not a callback's own parameter, not a name it only writes). `declared`: written by a
 *  declaration (fresh each time the line runs: never carried from one loop turn to the next). */
export function line_rw(line: string): {
	reads: string[];
	writes: string[];
	declared: string[];
	accum: string[];
} {
	const t = tokens(line);
	const writes = new Set<string>();
	const declared = new Set<string>();
	/** `x += …` targets: added to, in any order */
	const accum = new Set<string>();
	const params = new Set<string>();
	for (let m = 0; m < t.length; m++) {
		if (t[m] !== '=>') continue;
		if (t[m - 1] !== ')') {
			if (t[m - 1]) params.add(t[m - 1]);
			continue;
		}
		let d = 0;
		for (let j = m - 1; j >= 0; j--) {
			if (t[j] === ')') d++;
			else if (t[j] === '(' && --d === 0) break;
			else if (d >= 1 && is_id_start(t[j].charCodeAt(0)) && t[j - 1] !== ':') params.add(t[j]);
		}
	}
	/** token indexes that are written, not read */
	const skip = new Set<number>();
	for (let k = 0; k < t.length; k++) {
		if (t[k] === 'const' || t[k] === 'let' || t[k] === 'var') {
			let depth = 0;
			for (let j = k + 1; j < t.length; j++) {
				const x = t[j];
				if (depth === 0 && (x === '=' || x === 'of' || x === 'in' || x === ':')) break;
				if (x === '{' || x === '[') depth++;
				else if (x === '}' || x === ']') depth--;
				else if (is_id_start(x.charCodeAt(0)) && !NOT_A_NAME.has(x)) {
					skip.add(j);
					// `b: c` in a pattern: `b` is the field, `c` the name
					if (depth === 0 || t[j + 1] !== ':') {
						declared.add(x);
						writes.add(x);
					}
				}
			}
			continue;
		}
		if (
			!is_id_start(t[k].charCodeAt(0)) ||
			NOT_A_NAME.has(t[k]) ||
			t[k - 1] === '.' ||
			t[k - 1] === '?.'
		)
			continue;
		if (t[k + 1] === '.' && FILLS.has(t[k + 2]) && t[k + 3] === '(') {
			writes.add(t[k]);
			skip.add(k);
			continue;
		}
		let after = k + 1;
		if (t[after] === '[') {
			let d = 0;
			for (; after < t.length; after++)
				if (t[after] === '[') d++;
				else if (t[after] === ']' && --d === 0) break;
			after++;
		} else if (t[after] === '.' && t[after + 2] === '=') after += 2;
		if (t[after] === '=' || t[after] === '+=') {
			writes.add(t[k]);
			// `x += …` reads x too (an accumulation); `x = …` does not
			if (t[after] === '=') skip.add(k);
			else accum.add(t[k]);
		}
	}
	const reads = new Set<string>();
	for (let k = 0; k < t.length; k++) {
		const x = t[k];
		if (
			skip.has(k) ||
			!is_id_start(x.charCodeAt(0)) ||
			NOT_A_NAME.has(x) ||
			params.has(x) ||
			t[k - 1] === '.' ||
			t[k - 1] === '?.'
		)
			continue;
		// an object literal's key (`{ rows: n }`) names a field, not a variable
		if (t[k + 1] === ':' && (t[k - 1] === '{' || t[k - 1] === ',')) continue;
		reads.add(x);
	}
	return { reads: [...reads], writes: [...writes], declared: [...declared], accum: [...accum] };
}

/**
 * DOES THE LATER CALL NEED THE EARLIER ONE'S ANSWER? Two lines of one file: true when `to` reads a
 * name `from` wrote, directly or through the lines between (`const a = await x()` → `const id =
 * a.id` → `await y(id)`). One line (a loop making the calls): true when a turn feeds the next — a
 * name assigned (not declared) on it or the few lines after it, that it reads (`cursor = (await
 * get(cursor)).next`). Then the calls cannot run together, and "waits in a row" is not a fix.
 */
export function needs_previous(
	source: SourceReader,
	path: string,
	from: number,
	to: number
): boolean {
	if (from === to) {
		const got = source(path, from, from + 3);
		if (!got) return false;
		const here = line_rw(got.lines[0]);
		const carried = new Set<string>();
		for (const l of got.lines) {
			const rw = line_rw(l);
			for (const w of rw.writes) if (!rw.declared.includes(w)) carried.add(w);
		}
		// a receiver filled on the line (`list.push(await …)`) is written, not read back
		// (a sum it adds to, `total += await price(id)`, does not feed the next turn's call: the adds
		// can happen in any order)
		return here.reads.some((r) => carried.has(r) && !here.accum.includes(r));
	}
	if (to < from || to - from > 200) return false;
	const got = source(path, from, to);
	if (!got || got.lines.length < 2) return false;
	const produced = new Set(line_rw(got.lines[0]).writes);
	for (let i = 1; i < got.lines.length; i++) {
		const rw = line_rw(got.lines[i]);
		const hit = rw.reads.some((r) => produced.has(r));
		if (i === got.lines.length - 1) return hit;
		if (hit) for (const w of rw.writes) produced.add(w);
	}
	return false;
}

/**
 * WHAT THE PAGE WAITED ON THE LAYOUT FOR: in a load that does `await parent()`, the line doing it,
 * the names it sets (`const { session } = await parent()` → session), and the first line after it
 * that reads one of them (null: none does). The `await`s in between waited on the layout's loads
 * for data they never used. 1-based lines; null when there is no `await parent()`.
 */
export function parent_use(
	source: string
): { line: number; names: string[]; first_use: number | null; awaits_before_use: number } | null {
	const lines = source.split('\n');
	let at = -1;
	for (let i = 0; i < lines.length && at < 0; i++) {
		const t = tokens(lines[i]);
		for (let k = 0; k + 2 < t.length; k++)
			if (t[k] === 'await' && t[k + 1] === 'parent' && t[k + 2] === '(') at = i;
	}
	if (at < 0) return null;
	const names = line_rw(lines[at]).writes;
	if (!names.length) return null;
	const set = new Set(names);
	let awaits = 0;
	// to the load's end: the first line back at the load's own indent that closes it
	let depth = 0;
	for (let i = at + 1; i < lines.length; i++) {
		const t = tokens(lines[i]);
		const rw = line_rw(lines[i]);
		if (rw.reads.some((r) => set.has(r)))
			return { line: at + 1, names, first_use: i + 1, awaits_before_use: awaits };
		if (t.includes('await')) awaits++;
		for (const x of t) depth += x === '{' ? 1 : x === '}' ? -1 : 0;
		if (depth < 0) break;
	}
	return { line: at + 1, names, first_use: null, awaits_before_use: awaits };
}

/** globals whose calls give the same answer for the same input (a clock, a random or the network
 *  are not among them: `Date`, `Math`, `performance`, `crypto`, `fetch`) */
const PURE_GLOBALS: ReadonlySet<string> = new Set([
	'Object',
	'Array',
	'JSON',
	'String',
	'Number',
	'Boolean',
	'Map',
	'Set',
	'structuredClone',
	'parseInt',
	'parseFloat',
	'encodeURIComponent',
	'decodeURIComponent',
	'RegExp',
	'Intl'
]);

const NODE_MODULES: ReadonlySet<string> = new Set([
	'crypto',
	'fs',
	'fs/promises',
	'os',
	'path',
	'process',
	'child_process',
	'http',
	'https',
	'net',
	'perf_hooks',
	'worker_threads',
	'async_hooks',
	'util',
	'timers',
	'url',
	'zlib',
	'stream',
	'buffer',
	'events',
	'dns',
	'cluster',
	'v8',
	'vm'
]);

/** a module whose exports answer per call or per request, never a value to compute once: Node's own
 *  (`randomUUID`, `readFileSync`, `hrtime`) and the framework's request-bound ones (`getRequestEvent`,
 *  dynamic env) */
function per_call_module(from: string): boolean {
	return (
		from.startsWith('node:') ||
		NODE_MODULES.has(from) ||
		from.startsWith('$app/') ||
		from.startsWith('$env/dynamic/')
	);
}

/** the quoted module an `import … from '…'` line names ('' when it names none on this line) */
function import_source(line: string): string {
	const f = line.lastIndexOf('from');
	const at = f === -1 ? line.indexOf('import') + 6 : f + 4;
	for (let i = at; i < line.length; i++) {
		const q = line[i];
		if (q !== "'" && q !== '"') continue;
		const e = line.indexOf(q, i + 1);
		return e === -1 ? '' : line.slice(i + 1, e);
	}
	return '';
}

/** globals whose every use can answer differently: the network, a clock, the process, timers */
const PER_CALL_GLOBALS: ReadonlySet<string> = new Set([
	'fetch',
	'performance',
	'crypto',
	'process',
	'globalThis',
	'setTimeout',
	'setInterval',
	'setImmediate',
	'queueMicrotask',
	'require'
]);

/** methods that change what their receiver holds */
const MUTATORS: ReadonlySet<string> = new Set([
	'push',
	'pop',
	'shift',
	'unshift',
	'splice',
	'sort',
	'reverse',
	'fill',
	'copyWithin',
	'set',
	'add',
	'delete',
	'clear'
]);

/** the names a line CHANGES without declaring: `x = …`, `x.a.b = …`, `x[k] += …`, `x.list.push(…)`,
 *  `x.n++`, `delete x.k`, `Object.assign(x, …)` — the root name of each changed chain */
function changed_names(t: readonly string[]): string[] {
	const out = new Set<string>();
	for (let k = 0; k < t.length; k++) {
		const x = t[k];
		if (!is_id_start(x.charCodeAt(0)) || NOT_A_NAME.has(x) || t[k - 1] === '.' || t[k - 1] === '?.')
			continue;
		// `const x = …` makes x, it does not change it
		if (t[k - 1] === 'const' || t[k - 1] === 'let' || t[k - 1] === 'var') continue;
		if (
			x === 'Object' &&
			t[k + 1] === '.' &&
			t[k + 2] === 'assign' &&
			t[k + 3] === '(' &&
			is_id_start((t[k + 4] ?? '').charCodeAt(0))
		)
			out.add(t[k + 4]);
		if (t[k - 1] === 'delete') out.add(x);
		// walk the chain: `.name` and `[…]` steps
		let j = k + 1;
		let last = '';
		while (j < t.length) {
			if ((t[j] === '.' || t[j] === '?.') && is_id_start((t[j + 1] ?? '').charCodeAt(0))) {
				last = t[j + 1];
				j += 2;
			} else if (t[j] === '[') {
				let d = 0;
				for (; j < t.length; j++)
					if (t[j] === '[') d++;
					else if (t[j] === ']' && --d === 0) break;
				last = '';
				j++;
			} else break;
		}
		const after = t[j];
		if (
			after === '=' ||
			after === '+=' ||
			after === '-=' ||
			after === '*=' ||
			after === '/=' ||
			after === '||=' ||
			after === '&&=' ||
			after === '??=' ||
			after === '++' ||
			after === '--'
		)
			out.add(x);
		else if (after === '(' && j > k + 1 && MUTATORS.has(last)) out.add(x);
		else if (t[k - 1] === '++' || t[k - 1] === '--') out.add(x);
	}
	return [...out];
}

/**
 * THE SAME WORK EVERY REQUEST: the `const` lines of a `load` whose value depends on nothing the
 * request brings — only on the module's own imports and top-level values, pure globals, and other
 * such lines (`const valid = validateAll(PRODUCTS)`, then `const joined = attachBrands(valid)`).
 * Each request computes the same thing again; computed once at module load, it costs nothing.
 * Not a line that awaits (I/O is `same-answer`'s), nor one that reads the load's arguments
 * (`url`, `params`, `locals`, …), a `let`, or anything the file does not declare. `calls`: the
 * functions it runs (whose time is the line's cost). 1-based lines.
 */
export function constant_work(source: string): { line: number; names: string[]; calls: string[] }[];
/** with `spans`: EVERY constant `const` statement (a cheap alias too, `work: false`), each with its
 *  last line — what moves to module scope together, since one can read another */
export function constant_work(
	source: string,
	spans: true
): { line: number; end: number; names: string[]; calls: string[]; work: boolean }[];
export function constant_work(
	source: string,
	spans = false
): { line: number; end?: number; names: string[]; calls: string[]; work?: boolean }[] {
	const lines = source.split('\n');
	const T = lines.map((l) => tokens(l));
	// the load's body — every name bound inside it is per request
	const span = load_span(T);
	if (!span) return [];
	const { head, body0, body1 } = span;
	// the module's own values: its imports and its TOP-LEVEL declarations (outside the load, and
	// outside any other function: a helper's `const id = 1` is that helper's)
	const module_names = new Set<string>();
	/** what a per-call module gives (`randomUUID`, `readFileSync`) */
	const per_call = new Set<string>();
	/** the file's state: top-level `let` / `var`, and a `const` made with `new` (a cache) */
	const state = new Set<string>();
	/** the file's own helpers (a `function`, or a `const` holding one), each with its lines */
	const helpers: { name: string; from: number; to: number }[] = [];
	let file_depth = 0;
	for (let i = 0; i < T.length; i++) {
		const t = T[i];
		const at_top = file_depth === 0;
		for (const x of t) file_depth += x === '{' ? 1 : x === '}' ? -1 : 0;
		if (!at_top || (i >= head && i <= body1)) continue;
		if (t[0] === 'import') {
			// the whole statement: a braced list over several lines (`import {\n\trandomUUID\n} from
			// 'node:crypto'`) names its bindings on the lines between, and its module on the last
			let end = i;
			let text = lines[i];
			const all = [...t];
			let open = 0;
			for (const x of t) open += x === '{' ? 1 : x === '}' ? -1 : 0;
			while (open > 0 && end + 1 < T.length) {
				end++;
				text += '\n' + lines[end];
				for (const x of T[end]) {
					all.push(x);
					open += x === '{' ? 1 : x === '}' ? -1 : 0;
				}
			}
			// (its braces balance, but the loop counted only the first line's: back to the top level)
			i = end;
			file_depth = 0;
			// `randomUUID()` from node:crypto is not the same every request
			const into = per_call_module(import_source(text.split('\n').pop()!))
				? per_call
				: module_names;
			const from = all.indexOf('from');
			for (let k = 1; k < (from === -1 ? all.length : from); k++)
				if (
					is_id_start(all[k].charCodeAt(0)) &&
					all[k] !== 'type' &&
					all[k] !== 'as' &&
					all[k + 1] !== 'as'
				)
					into.add(all[k]);
			continue;
		}
		const j = t[0] === 'export' ? 1 : 0;
		const k = t[j] === 'async' ? j + 1 : j;
		const name = t[k + 1] ?? '';
		if ((t[k] === 'let' || t[k] === 'var') && is_id_start(name.charCodeAt(0))) state.add(name);
		// a top-level `const cache = new Map()` is STATE (what it holds changes between requests), not
		// a value to compute from
		if (t[k] === 'const' && t.includes('new')) {
			if (is_id_start(name.charCodeAt(0))) state.add(name);
			continue;
		}
		if (
			(t[k] === 'const' || t[k] === 'function' || t[k] === 'class') &&
			is_id_start(name.charCodeAt(0))
		) {
			module_names.add(name);
			// its lines: until every bracket it opens closes again, and on while a line ends mid
			// expression (`const stamp = () =>\n\tDate.now();`: a body with no braces at all)
			let to = i;
			const opens = (x: string) =>
				x === '{' || x === '(' || x === '[' ? 1 : x === '}' || x === ')' || x === ']' ? -1 : 0;
			let d = 0;
			for (const x of t) d += opens(x);
			const continues = (row: readonly string[]) => {
				const last = row[row.length - 1];
				return (
					last === '=>' ||
					last === '=' ||
					last === '(' ||
					last === ',' ||
					last === '?' ||
					last === ':' ||
					last === '&&' ||
					last === '||' ||
					last === '??'
				);
			};
			while ((d > 0 || continues(T[to])) && to + 1 < T.length) {
				to++;
				for (const x of T[to]) d += opens(x);
			}
			if (t[k] !== 'class' && (t[k] === 'function' || t.includes('=>')))
				helpers.push({ name, from: i, to });
		}
	}
	// A HELPER THAT ANSWERS PER CALL: one that reads a clock, a random, the disk or the network
	// (directly, through a per-call module, or through another such helper) or changes the file's
	// state (`recent.set(…)`, `count++`). Moved to the top, it would answer once for every request
	const impure = (t: readonly string[]) => {
		for (let k = 0; k < t.length; k++) {
			const x = t[k];
			if (t[k - 1] === '.' || t[k - 1] === '?.') continue;
			if (per_call.has(x) || PER_CALL_GLOBALS.has(x)) return true;
			if (x === 'Math' && t[k + 2] === 'random') return true;
			if (
				x === 'Date' &&
				(t[k + 2] === 'now' || (t[k - 1] === 'new' && t[k + 1] === '(' && t[k + 2] === ')'))
			)
				return true;
			if (helpers.some((h) => h.name === x) && !module_names.has(x)) return true;
		}
		return changed_names(t).some((n) => state.has(n));
	};
	for (let dropped = true; dropped;) {
		dropped = false;
		for (const h of helpers) {
			if (!module_names.has(h.name)) continue;
			for (let i = h.from; i <= h.to; i++)
				if (impure(T[i])) {
					module_names.delete(h.name);
					dropped = true;
					break;
				}
		}
	}
	// a value the load CHANGES after making it (`state.user = …`, `list.push(…)`) is that request's
	// own: made once and shared, every request would change the same object
	const changed = new Set<string>();
	for (let i = body0 + 1; i < body1; i++) for (const n of changed_names(T[i])) changed.add(n);
	// THE LOAD'S OWN NAMES: everything it binds (its parameters, and every declaration in its body,
	// awaited or not) — a `const products = await db.all()` shadows an imported `products`, and a
	// line reading it reads the request's rows, not the module's
	const local = new Set<string>();
	for (let i = body0 + 1; i < body1; i++) for (const n of line_rw(lines[i]).declared) local.add(n);
	for (let i = head; i <= body0; i++)
		for (const x of T[i])
			if (
				is_id_start(x.charCodeAt(0)) &&
				!NOT_A_NAME.has(x) &&
				x !== 'load' &&
				x !== 'export' &&
				x !== 'const' &&
				x !== 'async' &&
				x !== 'function'
			)
				local.add(x);
	/** a read the load can compute once: a constant line of its own, or the module's (or a pure
	 *  global) name that nothing in the load shadows */
	const known = (r: string) =>
		constant.has(r) || ((module_names.has(r) || PURE_GLOBALS.has(r)) && !local.has(r));
	let constant = new Set<string>();
	let out: { line: number; end?: number; names: string[]; calls: string[]; work?: boolean }[] = [];
	/** every line (0-based) of the constant statements, continuation lines included */
	let stmt_lines = new Set<number>();
	// again while a changed value turns out to be made from another (`const copy = rows` then
	// `copy.push(…)` changes rows too): whatever it was made from is not shared either
	for (let grew = true; grew;) {
		grew = false;
		constant = new Set();
		out = [];
		stmt_lines = new Set();
		let depth = 0;
		for (let i = body0 + 1; i < body1; i++) {
			const t = T[i];
			// the load's own statements only, not a callback's inside it
			const top = depth === 0;
			for (const x of t)
				depth +=
					x === '{' || x === '(' || x === '[' ? 1 : x === '}' || x === ')' || x === ']' ? -1 : 0;
			// a value written straight into the returned object (`catalog: span('x', () => catalog())`):
			// one entry per line, the expression after its key
			if (top && t[0] === 'return' && t[1] === '{') {
				let d = 0;
				for (let j = i + 1; j < body1; j++) {
					const e = T[j];
					const at_top = d === 0;
					for (const x of e)
						d +=
							x === '{' || x === '(' || x === '['
								? 1
								: x === ')' || x === ']' || x === '}'
									? -1
									: 0;
					if (d < 0) break;
					if (
						!at_top ||
						d !== 0 ||
						!is_id_start((e[0] ?? '').charCodeAt(0)) ||
						e[1] !== ':' ||
						e.includes('await')
					)
						continue;
					const text = lines[j].slice(lines[j].indexOf(':') + 1);
					const rw = line_rw(text);
					if (!rw.reads.length || !rw.reads.every(known)) continue;
					const et = tokens(text);
					const calls = rw.reads.filter(
						(r) => module_names.has(r) && et.some((x, k) => x === r && et[k + 1] === '(')
					);
					if (calls.length) {
						// (not a statement to move: with `spans`, only the `const` lines)
						if (!spans) out.push({ line: j + 1, names: [e[0]], calls });
						stmt_lines.add(j);
					}
				}
				break;
			}
			if (!top || t[0] !== 'const') continue;
			// the whole statement: on while its brackets stay open (`validateAll(\n  PRODUCTS\n)`)
			let open = 0;
			for (const x of t)
				open +=
					x === '(' || x === '[' || x === '{' ? 1 : x === ')' || x === ']' || x === '}' ? -1 : 0;
			let text = lines[i];
			const all = [...t];
			for (let j = i + 1; open > 0 && j < body1; j++) {
				text += '\n' + lines[j];
				for (const x of T[j]) {
					all.push(x);
					open +=
						x === '(' || x === '[' || x === '{' ? 1 : x === ')' || x === ']' || x === '}' ? -1 : 0;
				}
			}
			if (open !== 0 || all.includes('await')) continue;
			const rw = line_rw(text.split('\n').join(' '));
			if (!rw.declared.length || !rw.reads.length) continue;
			if (!rw.reads.every(known)) continue;
			if (rw.declared.some((n) => changed.has(n))) {
				for (const r of rw.reads)
					if (constant.has(r) && !changed.has(r)) {
						changed.add(r);
						grew = true;
					}
				continue;
			}
			// work, not a lookup: something is called
			const calls = rw.reads.filter(
				(r) => module_names.has(r) && all.some((x, k) => x === r && all[k + 1] === '(')
			);
			for (const n of rw.declared) constant.add(n);
			const end = i + text.split('\n').length;
			if (all.includes('(')) {
				out.push({ line: i + 1, names: rw.declared, calls, ...(spans ? { end, work: true } : {}) });
				for (let j = i; j < end; j++) stmt_lines.add(j);
			} else if (spans) out.push({ line: i + 1, end, names: rw.declared, calls: [], work: false });
		}
	}
	// a function the load also names on a line that is not constant: its time is not all this
	// work's, so it is not counted as this work's cost
	const mine = stmt_lines;
	for (const o of out)
		o.calls = o.calls.filter(
			(c) => !T.some((t, i) => i > body0 && i < body1 && !mine.has(i) && t.includes(c))
		);
	return out;
}

/**
 * THE MOVE, CHECKED: which of the load's constant statements go to the file's top level (the costly
 * ones and what they read, nothing else) and the line they go above (the load's `export`, 1-based).
 * Null when moving them could change what the file does:
 * - the file declares a top-level `const` / `let` / `var` / `class` AFTER the load. A moved call can
 *   run a helper that reads it before it is set (its temporal dead zone), so no line is safe to move
 *   above it;
 * - a moved name is already a top-level name of the file (an import, a const, a function).
 */
export function hoist_plan(
	source: string
): { above: number; stmts: { line: number; end: number; names: string[] }[] } | null {
	const all = constant_work(source, true);
	if (!all.some((x) => x.work)) return null;
	const lines = source.split('\n');
	const T = lines.map((l) => tokens(l));
	const span = load_span(T);
	if (!span) return null;
	const by_name = new Map<string, (typeof all)[number]>();
	for (const x of all) for (const n of x.names) by_name.set(n, x);
	const keep = new Set<(typeof all)[number]>();
	const visit = (x: (typeof all)[number]) => {
		if (keep.has(x)) return;
		keep.add(x);
		for (const r of line_rw(lines.slice(x.line - 1, x.end).join(' ')).reads) {
			const y = by_name.get(r);
			if (y) visit(y);
		}
	};
	for (const x of all) if (x.work) visit(x);
	const stmts = all
		.filter((x) => keep.has(x))
		.map((x) => ({ line: x.line, end: x.end, names: x.names }));
	// the file's own top-level names, and whether one is bound after the load
	const top = new Set<string>();
	let late = false;
	let depth = 0;
	for (let i = 0; i < T.length; i++) {
		const t = T[i];
		const at_top = depth === 0;
		for (const x of t) depth += x === '{' ? 1 : x === '}' ? -1 : 0;
		if (!at_top || (i >= span.head && i <= span.body1)) continue;
		if (t[0] === 'import') {
			// a braced list over several lines: its names up to the closing brace
			const ids: string[] = [];
			let j = i;
			for (let d = 0; j < T.length; j++) {
				for (const x of T[j]) {
					if (x === '{') d++;
					else if (x === '}') d--;
					else ids.push(x);
				}
				if (d <= 0) break;
			}
			for (let k = 0; k < ids.length; k++)
				if (
					is_id_start(ids[k].charCodeAt(0)) &&
					!NOT_A_NAME.has(ids[k]) &&
					ids[k] !== 'import' &&
					ids[k] !== 'from' &&
					ids[k] !== 'type' &&
					ids[k] !== 'as' &&
					ids[k + 1] !== 'as'
				)
					top.add(ids[k]);
			continue;
		}
		let k = t[0] === 'export' ? 1 : 0;
		if (t[k] === 'declare') k++;
		if (t[k] === 'const' || t[k] === 'let' || t[k] === 'var') {
			for (const n of line_rw(lines[i]).declared) top.add(n);
			if (i > span.body1) late = true;
		} else if (t[k] === 'class') {
			if (t[k + 1]) top.add(t[k + 1]);
			if (i > span.body1) late = true;
		} else if (t[k] === 'function' || (t[k] === 'async' && t[k + 1] === 'function')) {
			const n = t[k] === 'async' ? t[k + 2] : t[k + 1];
			if (n && n !== '*') top.add(n);
		}
	}
	if (late || stmts.some((x) => x.names.some((n) => top.has(n)))) return null;
	return { above: span.head + 1, stmts };
}

/** `data` at token `k` is the page's data: bare `data.x` (the prop), or `page.data.x` / `$page.data.x`
 *  — not another object's `data` (`post.data.tags`) */
function is_page_data(t: readonly string[], k: number): boolean {
	if (t[k - 1] !== '.') return true;
	return t[k - 2] === 'page' || t[k - 2] === '$page';
}

/** the page-data key a component's local is made from: `const products = data.catalog.…` → catalog */
function local_key(lines: readonly string[], name: string): string | undefined {
	for (const l of lines) {
		const t = tokens(l);
		const d = t.findIndex((x, k) => (x === 'const' || x === 'let') && t[k + 1] === name);
		if (d === -1) continue;
		for (let j = d + 2; j < t.length; j++)
			if (
				t[j] === 'data' &&
				t[j + 1] === '.' &&
				is_id_start((t[j + 2] ?? '').charCodeAt(0)) &&
				is_page_data(t, j)
			)
				return t[j + 2];
		return undefined;
	}
	return undefined;
}

/**
 * THE LOOPS IN A COMPONENT'S MARKUP: each `{#each … as …}` block, the page-data key it walks
 * (`data.results`, `page.data.results` → results), and the components rendered inside it
 * (`<ResultCard …>`, nested blocks included). What decides how many times a child renders.
 * 1-based lines.
 */
export function each_blocks(
	svelte: string
): { line: number; key?: string; components: string[] }[] {
	const lines = svelte.split('\n');
	const out: { line: number; key?: string; components: Set<string> }[] = [];
	const open: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = tokens(lines[i]);
		for (let k = 0; k < t.length; k++) {
			if (t[k] === '{' && t[k + 1] === '#' && t[k + 2] === 'each') {
				// `data . results` (or `page . data . results`) before `as`
				let key: string | undefined;
				for (let j = k + 3; j < t.length && t[j] !== 'as'; j++)
					if (
						t[j] === 'data' &&
						t[j + 1] === '.' &&
						is_id_start((t[j + 2] ?? '').charCodeAt(0)) &&
						is_page_data(t, j)
					)
						key = t[j + 2];
				// a local (`{#each products as p}`): the script line that makes it from page data
				// (`const products = data.catalog.products.map(…)` → catalog)
				if (!key && is_id_start((t[k + 3] ?? '').charCodeAt(0)) && t[k + 4] === 'as')
					key = local_key(lines, t[k + 3]);
				out.push({ line: i + 1, ...(key ? { key } : {}), components: new Set() });
				open.push(out.length - 1);
			} else if (t[k] === '{' && t[k + 1] === '/' && t[k + 2] === 'each') open.pop();
			else if (
				t[k] === '<' &&
				open.length &&
				/* a component: capitalised tag */ (t[k + 1] ?? '').charCodeAt(0) >= 65 &&
				(t[k + 1] ?? '').charCodeAt(0) <= 90
			) {
				for (const o of open) out[o].components.add(t[k + 1]);
			}
		}
	}
	return out.map((o) => ({
		line: o.line,
		...(o.key ? { key: o.key } : {}),
		components: [...o.components]
	}));
}

/**
 * DATA ONLY A LATE ISLAND NEEDS: in a page's markup, the page-data keys used ONLY as props of
 * islands imported to wake late (`import Reviews from './Reviews.svelte' with { wake: 'visible' }`
 * — or `idle`, `interaction`), never in the page's own markup or an eager island. The page waits
 * for that data on every request for something seen later, if at all. An island already
 * `render: 'deferred'` fetches later by itself and is not one. 1-based lines of each use.
 */
export function late_island_keys(
	svelte: string
): { key: string; island: string; wake: string; line: number }[] {
	const lines = svelte.split('\n');
	const late = new Map<string, string>();
	for (const l of lines) {
		const t = tokens(l);
		if (t[0] !== 'import' || !t.includes('with')) continue;
		const name = t[1];
		const w = t.indexOf('wake');
		const deferred = t.includes('render');
		// the wake word is a string token (`""`), so read it from the text
		const m = w !== -1 ? l.slice(l.indexOf('wake')) : '';
		const word = ['visible', 'idle', 'interaction'].find(
			(x) => m.includes(`'${x}'`) || m.includes(`"${x}"`)
		);
		if (name && word && !deferred) late.set(name, word);
	}
	if (!late.size) return [];
	// every use of `data.KEY` (or `page.data.KEY`): inside which tag — the nearest `<Name` before it,
	// still open (a tag's props can run over several lines)
	const uses = new Map<string, { island?: string; line: number }[]>();
	let tag: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const t = tokens(lines[i]);
		for (let k = 0; k < t.length; k++) {
			if (t[k] === '<' && is_id_start((t[k + 1] ?? '').charCodeAt(0))) tag = t[k + 1];
			else if (t[k] === '>') tag = undefined;
			if (
				t[k] === 'data' &&
				t[k + 1] === '.' &&
				is_id_start((t[k + 2] ?? '').charCodeAt(0)) &&
				is_page_data(t, k)
			) {
				const list = uses.get(t[k + 2]) ?? [];
				list.push({ ...(tag && late.has(tag) ? { island: tag } : {}), line: i + 1 });
				uses.set(t[k + 2], list);
			}
		}
	}
	const out: { key: string; island: string; wake: string; line: number }[] = [];
	for (const [key, list] of uses) {
		if (!list.every((u) => u.island)) continue;
		out.push({
			key,
			island: list[0].island!,
			wake: late.get(list[0].island!)!,
			line: list[0].line
		});
	}
	return out;
}

/** What a `load` takes from the request: the names in its parameter list (`async ({ url, cookies })`
 *  → url, cookies). Empty when it takes nothing; null when there is no load. */
export function load_inputs(source: string): string[] | null {
	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const t = tokens(lines[i]);
		if (
			t[0] !== 'export' ||
			!t.some((x, k) => x === 'load' && (t[k - 1] === 'const' || t[k - 1] === 'function'))
		)
			continue;
		// the parameter list, over lines: a `function load(…)`'s parens; an arrow's, the ones right
		// before its `=>` (walked back — `(async ({ url }) => …) satisfies …` wraps it in more parens)
		const all: string[] = [];
		for (let j = i; j < Math.min(lines.length, i + 20); j++) all.push(...tokens(lines[j]));
		let k = all.indexOf('load');
		const is_fn = all[k - 1] === 'function';
		if (is_fn) {
			while (k < all.length && all[k] !== '(') k++;
		} else {
			const arrow = all.indexOf('=>', k);
			if (arrow === -1 || all[arrow - 1] !== ')') {
				// `async event => …`: one bare parameter
				return arrow > 0 && is_id_start((all[arrow - 1] ?? '').charCodeAt(0))
					? ['*' + all[arrow - 1]]
					: [];
			}
			let back = 0;
			for (k = arrow - 1; k > 0; k--) {
				if (all[k] === ')') back++;
				else if (all[k] === '(' && --back === 0) break;
			}
		}
		let d = 0;
		const names: string[] = [];
		for (; k < all.length; k++) {
			const x = all[k];
			if (x === '(' || x === '{' || x === '[') d++;
			else if (x === ')' || x === '}' || x === ']') {
				if (--d === 0) break;
			}
			// the whole event taken as one parameter (`(event) =>`): it may read anything — `*event`
			else if (d === 1 && is_id_start(x.charCodeAt(0)) && all[k - 1] === '(') names.push('*' + x);
			// a field taken from the event: a name in key position (`{ url, locals: { user } }`)
			else if (
				d === 2 &&
				is_id_start(x.charCodeAt(0)) &&
				(all[k - 1] === '{' || all[k - 1] === ',')
			)
				names.push(x);
		}
		return names;
	}
	return null;
}

/**
 * THE CHANGE, WRITTEN: awaits in a row as one `Promise.all` — when they are plain one-line
 * statements (`const user = await get('user');`), next to each other (blank and comment lines
 * between are fine; any other statement between could feed a later call, so none is), the rewrite
 * only moves the later calls up to start with the first. The caller has already proved no call
 * reads what an earlier one produced. `lines`: the source from the first line to the last (1-based
 * `start`); `at`: the chain's lines. Undefined when the shape is anything else.
 */
export function promise_all_rewrite(
	lines: readonly string[],
	start: number,
	at: readonly number[]
): { before: string; after: string } | undefined {
	if (at.length < 2) return undefined;
	const set = new Set(at);
	const first = Math.min(...at);
	const last = Math.max(...at);
	const decls: { binding: string; expr: string }[] = [];
	let indent = '';
	let kind = 'const';
	for (let n = first; n <= last; n++) {
		const raw = lines[n - start];
		if (raw === undefined) return undefined;
		const l = raw.trim();
		if (!set.has(n)) {
			if (l === '' || l.startsWith('//')) continue;
			return undefined;
		}
		const d = await_decl(l);
		if (!d) return undefined;
		if (d.kind === 'let') kind = 'let';
		if (n === first) indent = raw.slice(0, raw.length - raw.trimStart().length);
		decls.push(d);
	}
	const before = lines.slice(first - start, last - start + 1).join('\n');
	const after = `${indent}${kind} [${decls.map((d) => d.binding).join(', ')}] = await Promise.all([${decls.map((d) => d.expr).join(', ')}]);`;
	return { before, after };
}

/** where a line's code ends: before a `//` or `/*` comment that is not inside a string */
function code_end(s: string): number {
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
			continue;
		}
		if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) return i;
	}
	return s.length;
}

/** names that say a call CHANGES something (`db.insert`, `saveCart`): two of them started together
 *  can land in either order, so a chain with one stays in a row */
const WRITE_VERBS = [
	'insert',
	'update',
	'delete',
	'remove',
	'save',
	'create',
	'put',
	'post',
	'patch',
	'write',
	'send',
	'set',
	'add',
	'upsert',
	'increment',
	'decrement',
	'mark',
	'lock',
	'commit',
	'publish',
	'enqueue',
	'push',
	'reserve',
	'charge'
];

/**
 * One statement `const <binding> = await <call>;` split into its binding and call, or undefined when
 * the line is any other shape: a type on the binding (`const a: User = …`), two names (`const a =
 * …, b = …`), a second statement or an `await` inside the call, anything done to the answer
 * (`await f() + 1`, `await f() || x`: moved into an array, the operator would apply to the promise),
 * or a call whose name says it writes.
 */
function await_decl(
	line: string
): { kind: 'const' | 'let'; binding: string; expr: string } | undefined {
	let body = line.slice(0, code_end(line)).trim();
	if (body.endsWith(';')) body = body.slice(0, -1).trimEnd();
	const kind = body.startsWith('const ') ? 'const' : body.startsWith('let ') ? 'let' : undefined;
	if (!kind) return undefined;
	// the first `=` outside brackets and strings
	let eq = -1;
	for (let i = kind.length, d = 0; i < body.length && eq < 0; i++) {
		const c = body[i];
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
		} else if (c === '(' || c === '[' || c === '{') d++;
		else if (c === ')' || c === ']' || c === '}') d--;
		else if (d === 0 && (c === ':' || c === ',' || c === ';')) return undefined;
		else if (d === 0 && c === '=' && body[i + 1] !== '=' && body[i + 1] !== '>') eq = i;
	}
	if (eq < 0) return undefined;
	const binding = body.slice(kind.length, eq).trim();
	const rest = body.slice(eq + 1).trim();
	if (!binding || !rest.startsWith('await ')) return undefined;
	const expr = rest.slice(6).trim();
	const e = tokens(expr);
	if (e.includes('await') || e.includes(';')) return undefined;
	// ONE call chain: `new`? a name, then `.name` / `?.name` / `(…)` / `[…]` steps, ending in a call
	let j = e[0] === 'new' ? 1 : 0;
	if (!is_id_start((e[j] ?? '').charCodeAt(0))) return undefined;
	const names = [e[j++]];
	let called = false;
	while (j < e.length) {
		if ((e[j] === '.' || e[j] === '?.') && is_id_start((e[j + 1] ?? '').charCodeAt(0))) {
			names.push(e[j + 1]);
			j += 2;
			called = false;
		} else if (e[j] === '(' || e[j] === '[') {
			called = e[j] === '(';
			let d = 0;
			for (; j < e.length; j++) {
				if (e[j] === '(' || e[j] === '[' || e[j] === '{') d++;
				else if ((e[j] === ')' || e[j] === ']' || e[j] === '}') && --d === 0) break;
			}
			if (d !== 0) return undefined;
			j++;
		} else return undefined;
	}
	if (!called) return undefined;
	// the verb as a whole word of the name: `insert`, `saveCart`, `set_flag` (not `settings`, `posts`)
	const says_write = (n: string) =>
		WRITE_VERBS.some((v) => {
			if (!n.toLowerCase().startsWith(v)) return false;
			const next = n[v.length];
			return next === undefined || next === '_' || (next >= 'A' && next <= 'Z');
		});
	if (names.some(says_write)) return undefined;
	// a fetch that sends (`method: 'POST'`): not a read
	if (e.includes('method') && !expr.includes("'GET'") && !expr.includes('"GET"')) return undefined;
	return { kind, binding, expr };
}

/** the balanced `( … )` text starting at `open` (the index of `(`), and the index past its `)` */
function paren_text(s: string, open: number): { inner: string; end: number } | undefined {
	let d = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === '"' || c === "'" || c === '`') {
			const q = c;
			for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
			continue;
		}
		if (c === '(') d++;
		else if (c === ')' && --d === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
	}
	return undefined;
}

/**
 * THE CHANGE, WRITTEN, for a formatter built on every call: `new Intl.NumberFormat(locale, {…})` on
 * a line. Arguments that read nothing (literals only) → one formatter at the top of the file, used
 * on the line. Arguments that read variables → a cached factory at the top (one formatter per
 * locale + options, built once) called on the line in place of `new Intl.X(`. A `.localeCompare(y,
 * 'de', {…})` with literal arguments → one `Intl.Collator`'s `compare`. `ts`: the file is TypeScript
 * (the factory is typed). Undefined when the line is anything else.
 */
export function formatter_rewrite(
	line: string,
	opts: FormatterRewriteOptions
): { before: string; after: string } | undefined {
	const { ts, svelte = false } = opts;
	const taken = opts.taken ?? new Set(tokens(line));
	const made = opts.made ?? new Map<string, string>();
	const edits: { start: number; end: number; text: string }[] = [];
	const tops: string[] = [];
	const reused = new Set<string>();
	/** the name for one addition: the one already made for the same thing, else a fresh one no name
	 *  of the file uses (`COLLATOR`, `COLLATOR_2`); `decl` writes the addition under that name */
	const name_for = (
		key: string,
		base: string,
		decl: (name: string) => string,
		also: (name: string) => string[] = () => []
	): string => {
		const had = made.get(key);
		if (had) {
			reused.add(had);
			return had;
		}
		let name = base;
		for (let n = 2; taken.has(name) || also(name).some((x) => taken.has(x)); n++)
			name = `${base}_${n}`;
		taken.add(name);
		for (const x of also(name)) taken.add(x);
		made.set(key, name);
		tops.push(decl(name));
		return name;
	};
	// every `new Intl.X(…)` on the line
	for (let at = code_index(line, 'new Intl.'); at !== -1;) {
		let k = at + 'new Intl.'.length;
		while (k < line.length && is_id_part(line.charCodeAt(k))) k++;
		const ctor = line.slice(at + 'new Intl.'.length, k);
		const args = line[k] === '(' ? paren_text(line, k) : undefined;
		if (!ctor || !args) return undefined;
		let snake = '';
		for (let i = 0; i < ctor.length; i++) {
			const c = ctor[i];
			snake += c >= 'A' && c <= 'Z' ? (i ? '_' : '') + c.toLowerCase() : c;
		}
		const reads = line_rw(`x(${args.inner})`).reads.filter((r) => r !== 'x');
		if (!reads.length) {
			const name = name_for(
				`const|${ctor}|${args.inner}`,
				snake.toUpperCase(),
				(n) => `const ${n} = new Intl.${ctor}(${args.inner});`
			);
			edits.push({ start: at, end: args.end, text: name });
		} else {
			const shape = FACTORY_CTORS.get(ctor);
			// (`new Intl.Locale(tag)` is not a formatter built from a locale list: no factory)
			if (!shape) {
				at = code_index(line, 'new Intl.', args.end);
				continue;
			}
			const types = ts
				? {
						loc: ': Intl.LocalesArgument',
						opt: shape.required ? `: Intl.${ctor}Options` : `?: Intl.${ctor}Options`,
						map: `<string, Intl.${ctor}>`
					}
				: { loc: '', opt: '', map: '' };
			const name = name_for(
				`factory|${ctor}`,
				snake,
				(n) =>
					[
						`const ${n}_cache = new Map${types.map}();`,
						`function ${n}(locale${types.loc}, options${types.opt}) {`,
						`\tconst key = \`\${String(locale)}|\${JSON.stringify(options)}\`;`,
						`\tlet f = ${n}_cache.get(key);`,
						`\tif (!f) ${n}_cache.set(key, (f = new Intl.${ctor}(locale, options)));`,
						`\treturn f;`,
						`}`
					].join('\n'),
				(n) => [`${n}_cache`]
			);
			edits.push({ start: at, end: args.end, text: `${name}(${args.inner})` });
		}
		at = code_index(line, 'new Intl.', args.end);
	}
	// every `a.localeCompare(b, 'de', { … })`: a collator built per compare
	for (let lc = code_index(line, '.localeCompare('); lc !== -1;) {
		const args = paren_text(line, lc + '.localeCompare'.length);
		if (!args) return undefined;
		const parts = split_args(args.inner);
		const next = code_index(line, '.localeCompare(', args.end);
		// `a?.localeCompare(b, 'de')`: undefined when `a` is — a collator's compare has no such
		// answer, so the change would not be the same code; left for the reader
		if (line[lc - 1] === '?') {
			lc = next;
			continue;
		}
		// `a.localeCompare(b)`: no collator is built for it (the default one is cached)
		if (parts.length < 2) {
			lc = next;
			continue;
		}
		const other = parts[0];
		const rest = parts.slice(1).join(', ');
		// a locale from a variable: not one collator for the file
		if (line_rw(`x(${rest})`).reads.some((r) => r !== 'x')) {
			lc = next;
			continue;
		}
		// the receiver: the member chain right before `.localeCompare` — names, `.`, `?.` and
		// bracketed steps (`a.name`, `row[k].title`, `get(x).label`), nothing an operator joins
		let s = lc - 1;
		while (s >= 0) {
			const c = line[s];
			if (is_id_part(c.charCodeAt(0)) || c === '.' || (c === '?' && line[s + 1] === '.')) s--;
			else if (c === ')' || c === ']') {
				const open = c === ')' ? '(' : '[';
				let d = 0;
				for (; s >= 0; s--) {
					if (line[s] === c) d++;
					else if (line[s] === open && --d === 0) break;
				}
				s--;
			} else break;
		}
		const recv = line.slice(s + 1, lc);
		if (
			!recv ||
			!is_id_start(recv.charCodeAt(0)) ||
			edits.some((e) => e.start < args.end && s + 1 < e.end)
		) {
			lc = next;
			continue;
		}
		const name = name_for(
			`collator|${rest}`,
			'COLLATOR',
			(n) => `const ${n} = new Intl.Collator(${rest});`
		);
		edits.push({ start: s + 1, end: args.end, text: `${name}.compare(${recv}, ${other})` });
		lc = next;
	}
	if (!edits.length) return undefined;
	edits.sort((a, b) => a.start - b.start);
	let changed = '';
	let from = 0;
	for (const e of edits) {
		changed += line.slice(from, e.start) + e.text;
		from = e.end;
	}
	changed += line.slice(from);
	const where = svelte
		? 'in `<script module>` (built once, not per render)'
		: 'at the top of the file (built once)';
	const head = [
		...(tops.length ? [`// ${where}:`, ...tops] : []),
		...(reused.size ? [`// uses ${[...reused].join(', ')}, added by the change above`] : [])
	];
	return { before: line, after: `${head.join('\n')}\n// the line:\n${changed}` };
}

export interface FormatterRewriteOptions {
	/** the file is TypeScript: the factory is typed */
	ts: boolean;
	/** a component: the addition goes in `<script module>` (its instance script runs per render) */
	svelte?: boolean;
	/** every name the file already uses; the names this adds join it */
	taken?: Set<string>;
	/** what earlier rewrites in the same file added (what → name): the same formatter is reused */
	made?: Map<string, string>;
}

/** Intl constructors taken as `(locales, options)` — what one cached factory can build — and
 *  whether their options are required */
const FACTORY_CTORS: ReadonlyMap<string, { required: boolean }> = new Map([
	['NumberFormat', { required: false }],
	['DateTimeFormat', { required: false }],
	['RelativeTimeFormat', { required: false }],
	['PluralRules', { required: false }],
	['Collator', { required: false }],
	['ListFormat', { required: false }],
	['Segmenter', { required: false }],
	['DisplayNames', { required: true }]
]);

/** the index of `needle` in a line's code, at or after `from`: not inside a string, not in a
 *  comment. -1 when none. */
function code_index(line: string, needle: string, from = 0): number {
	const end = code_end(line);
	for (let i = from; i < end; i++) {
		const c = line[i];
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < end && line[i] !== c; i++) if (line[i] === '\\') i++;
			continue;
		}
		if (line.startsWith(needle, i)) return i;
	}
	return -1;
}

/** a call's argument text split at its top-level commas (not one inside a call, an object or a string) */
function split_args(inner: string): string[] {
	const out: string[] = [];
	let d = 0;
	let from = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++;
		} else if (c === '(' || c === '[' || c === '{') d++;
		else if (c === ')' || c === ']' || c === '}') d--;
		else if (c === ',' && d === 0) {
			out.push(inner.slice(from, i).trim());
			from = i + 1;
		}
	}
	const last = inner.slice(from).trim();
	if (last) out.push(last);
	return out;
}

/** The functions a set of lines names — called (`newestReview(x)`) or handed over (`.sort(byName)`):
 *  every bare identifier on them (not a property, not a keyword). What a CPU row by that name, run
 *  from a helper file with no line of the load on its samples, was working for. */
export function names_on(source: string, lines: readonly number[]): string[] {
	const all = source.split('\n');
	const out = new Set<string>();
	for (const l of lines) {
		const t = tokens(all[l - 1] ?? '');
		for (let k = 0; k < t.length; k++)
			if (
				is_id_start(t[k].charCodeAt(0)) &&
				!NOT_A_NAME.has(t[k]) &&
				t[k - 1] !== '.' &&
				t[k - 1] !== '?.'
			)
				out.add(t[k]);
	}
	return [...out];
}
