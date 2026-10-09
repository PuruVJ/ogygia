/**
 * `script()` — an inline `<script>` tag as a string, for the work a csr=false page must do in the
 * HTML itself: before the first paint (a no-flash theme), before any island wakes (an early flag),
 * or as data the page carries (JSON config, JSON-LD, an import map, speculation rules).
 *
 * ONE call shape: a plain object holding exactly one payload key — `run` (a function), `json`, `ld`,
 * `importmap` or `speculation` — beside the tag's attributes. It spreads, it builds from config, and
 * TypeScript refuses the combinations a browser silently ignores. A bare function (with any trailing
 * args) is the shortcut for a plain classic script: `script(fn, a, b)` = `{ run: fn, args: [a, b] }`.
 * The result is a string: `{@html}` it where the tag should land (usually `<svelte:head>`).
 *
 * ```svelte
 * <svelte:head>
 *   {@html script(() => { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; })}
 *   {@html script((k) => apply(localStorage.getItem(k)), 'theme')}
 *   {@html script({ run: (href) => loadFont(href), args: [fontUrl], type: 'module' })}
 *   {@html script({ ld: { '@context': 'https://schema.org', '@type': 'Article', headline } })}
 * </svelte:head>
 * ```
 *
 * A `run` function is inlined through `Function.prototype.toString`, so it must be SELF-CONTAINED:
 * browser globals only — no imports, no closed-over variables (they do not exist in the browser).
 * Pass what it needs as `args`; they are JSON-serialized and handed to it in order.
 */
import { escape_attr, escape_script_text } from './escape.js';

/** A JSON value (what `args` and the data payloads carry). */
export type ScriptJson = string | number | boolean | null | ScriptJson[] | { [key: string]: ScriptJson | undefined };

/** The attributes every kind of inline script may carry. `true` renders a bare attribute;
 *  `false` / `null` / `undefined` leave it out. */
export interface ScriptAttrs {
	/** The element id (to find or replace the tag later). */
	id?: string;
	/** The page's CSP nonce, when its policy allows inline scripts by nonce. */
	nonce?: string;
	/** Any `data-*` attribute. */
	[data: `data-${string}`]: string | number | boolean | null | undefined;
}

type NoPayload = { json?: never; ld?: never; importmap?: never; speculation?: never };
type NoRun = { run?: never; args?: never; type?: never; async?: never; nomodule?: never; imports?: never };

/** What survives the JSON trip unchanged. A `Date` would arrive as a string, a `Map` / `Set` as
 *  `{}`, a function or class method not at all — those are `never`, so TypeScript refuses them. */
export type JsonSafe<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends bigint | symbol | ((...a: never[]) => unknown) | Date | RegExp | Map<unknown, unknown> | Set<unknown>
		? never
		: { [K in keyof T]: JsonSafe<T[K]> };

/** `run`'s parameters as they may be passed: inferred from the call, each one JSON-safe. */
export type ScriptArgs<A extends unknown[]> = A & { [K in keyof A]: JsonSafe<A[K]> };

/** `args` is required exactly when `run` takes parameters. */
type RunArgs<A extends unknown[]> = A extends [] ? { args?: [] } : { args: ScriptArgs<A> };

/**
 * A CLASSIC inline script (the default): runs where it stands, before the parser goes on — so in
 * `<head>` it runs before the first paint. (`async` / `defer` do nothing on an inline classic script,
 * so they are not offered: use `type: 'module'`.)
 */
export type ClassicScript<A extends unknown[]> = ScriptAttrs &
	NoPayload & {
		run: (...args: A) => unknown;
		type?: 'classic';
		/** Skip it in browsers that run modules (a fallback for very old ones). */
		nomodule?: boolean;
		async?: never;
		/** (static imports need a module: `type: 'module'`) */
		imports?: never;
	} & RunArgs<A>;

/**
 * A MODULE inline script: its own scope, strict mode, `import()` available, and runs after the
 * document is parsed (the first paint does not wait for it — code that must apply before paint is a
 * classic script). An `async` `run` is awaited, so its rejection reports as the module's.
 * (`blocking="render"` is not offered: measured, it does not hold the paint for an inline module.)
 */
export type ModuleScript<A extends unknown[]> = ScriptAttrs &
	NoPayload & {
		run: (...args: A) => unknown;
		type: 'module';
		/** Run as soon as it is ready, without waiting for the document to finish parsing. */
		async?: boolean;
		nomodule?: never;
		imports?: never;
	} & RunArgs<A>;

/** The module namespaces `imports` hands to `run`, by the names it declared. (Untyped: annotate the
 *  parameter — `({ carousel }: { carousel: typeof import('…') })` — when you have the module's types.) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScriptImports<I extends Record<string, string>> = { readonly [K in keyof I]: any };

/**
 * A MODULE inline script that needs modules: `imports` are written as static `import * as …` before
 * the call — data, not code, so no bundler rewrites them (an `import()` inside `run` would be: Vite's
 * SSR transform turns it into `__vite_ssr_dynamic_import__`, which the browser does not have). `run`
 * gets the namespaces as ONE object first, then `args`.
 */
export type ModuleImportsScript<I extends Record<string, string>, A extends unknown[]> = ScriptAttrs &
	NoPayload & {
		/** Name → URL of each module to import (an absolute or root-relative URL, or a specifier the
		 *  page's import map resolves). */
		imports: I;
		run: (modules: ScriptImports<I>, ...args: A) => unknown;
		type: 'module';
		async?: boolean;
		nomodule?: never;
	} & RunArgs<A>;

/** `<script type="application/json">` — data for code on the page to read (`JSON.parse(el.textContent)`). */
export type JsonScript = ScriptAttrs & NoRun & { json: ScriptJson; ld?: never; importmap?: never; speculation?: never };

/** `<script type="application/ld+json">` — structured data for search engines. */
export type LdScript = ScriptAttrs & NoRun & { ld: ScriptJson; json?: never; importmap?: never; speculation?: never };

/** `<script type="importmap">` — bare specifiers for the page's module scripts. */
export type ImportMapScript = ScriptAttrs &
	NoRun & {
		importmap: { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>>; integrity?: Record<string, string> };
		json?: never;
		ld?: never;
		speculation?: never;
	};

/** `<script type="speculationrules">` — the pages the browser may prefetch or prerender. */
export type SpeculationScript = ScriptAttrs &
	NoRun & {
		speculation: { prefetch?: ScriptJson[]; prerender?: ScriptJson[] } & { [key: string]: ScriptJson | undefined };
		json?: never;
		ld?: never;
		importmap?: never;
	};

export type ScriptOptions<A extends unknown[] = unknown[]> =
	| ClassicScript<A>
	| ModuleScript<A>
	| ModuleImportsScript<Record<string, string>, A>
	| JsonScript
	| LdScript
	| ImportMapScript
	| SpeculationScript;

/** The payload and option keys — everything else in the object is an attribute. */
const RESERVED = new Set(['run', 'args', 'imports', 'json', 'ld', 'importmap', 'speculation', 'type']);

/**
 * An inline `<script>` tag. Pass a function and its args (shortcut for `{ run: fn, args }`) or one
 * options object; see
 * the module doc. Throws on an object with no payload or more than one, and on an attribute name
 * that is not one.
 */
export function script<A extends unknown[]>(run: (...args: A) => unknown, ...args: ScriptArgs<A>): string;
export function script<A extends unknown[]>(options: ClassicScript<A> | ModuleScript<A>): string;
// (`A = []`: a `run` that takes only the modules leaves nothing to infer `A` from)
export function script<I extends Record<string, string>, A extends unknown[] = []>(options: ModuleImportsScript<I, A>): string;
export function script(options: JsonScript | LdScript | ImportMapScript | SpeculationScript): string;
export function script(input: ((...args: never[]) => unknown) | object, ...rest: unknown[]): string {
	const o = (typeof input === 'function' ? { run: input, args: rest } : input) as Record<string, unknown>;
	let type: string | null = null;
	let body: string;
	let kinds = 0;
	if (o.run !== undefined) {
		kinds++;
		if (typeof o.run !== 'function') throw new TypeError('[ogygia] script(): `run` must be a function');
		const module = o.type === 'module';
		if (module) type = 'module';
		const args = (o.args as unknown[] | undefined) ?? [];
		// (each arg as JSON with `<` escaped — a string arg can never close the tag; an `undefined`
		// arg stays a positional `undefined`, not a hole in the call)
		let call = '';
		for (let i = 0; i < args.length; i++) {
			const json = JSON.stringify(args[i]);
			call += (i ? ',' : '') + (json === undefined ? 'undefined' : escape_script_text(json));
		}
		// `imports`: static `import * as` lines first, the namespaces handed to `run` as one object
		let lines = '';
		if (o.imports !== undefined) {
			if (!module) throw new TypeError('[ogygia] script(): `imports` needs `type: \'module\'` (a static import only works in a module)');
			let mods = '';
			let n = 0;
			const imports = o.imports as Record<string, unknown>;
			for (const name in imports) {
				const url = imports[name];
				if (typeof url !== 'string' || !url) throw new TypeError(`[ogygia] script(): \`imports.${name}\` must be a URL string`);
				lines += `import * as __og_m${n} from ${escape_script_text(JSON.stringify(url))};`;
				mods += (n ? ',' : '') + `${escape_script_text(JSON.stringify(name))}:__og_m${n}`;
				n++;
			}
			call = `{${mods}}` + (call ? ',' + call : '');
		}
		const src = fn_source(o.run);
		// A bundler rewrote the function before it reached us: Vite's SSR transform turns an `import()`
		// (and an imported binding) inside it into `__vite_ssr_…` helpers the browser does not have.
		if (src.indexOf('__vite_ssr_') !== -1)
			throw new TypeError(
				"[ogygia] script(): `run` was rewritten by the bundler (it holds `__vite_ssr_…`): an `import()` or an imported binding inside it cannot cross into the browser. Declare the module in `imports` (with `type: 'module'`) and read it from `run`'s first parameter."
			);
		// (a module awaits its `run`: an async rejection reports as the module's own)
		body = `${lines}${module ? 'await ' : ''}(${close_safe(src)})(${call});`;
	} else {
		body = '';
	}
	for (const [key, kind] of DATA_KINDS) {
		if (o[key] === undefined) continue;
		kinds++;
		type = kind;
		const json = JSON.stringify(o[key]);
		if (json === undefined) throw new TypeError(`[ogygia] script(): \`${key}\` must be JSON-serializable`);
		body = escape_script_text(json);
	}
	if (kinds !== 1)
		throw new TypeError(
			`[ogygia] script(): pass exactly one of \`run\`, \`json\`, \`ld\`, \`importmap\`, \`speculation\` (got ${kinds})`
		);
	let attrs = type ? ` type="${type}"` : '';
	for (const key in o) {
		if (RESERVED.has(key)) continue;
		const v = o[key];
		if (v === undefined || v === null || v === false) continue;
		if (!is_attr_name(key)) throw new TypeError(`[ogygia] script(): \`${key}\` is not an attribute name`);
		attrs += v === true ? ' ' + key : ` ${key}="${escape_attr(String(v))}"`;
	}
	return `<script${attrs}>${body}</script>`;
}

const DATA_KINDS = [
	['json', 'application/json'],
	['ld', 'application/ld+json'],
	['importmap', 'importmap'],
	['speculation', 'speculationrules']
] as const;

/**
 * Code that cannot leave the tag it lives in. Two HTML tokenizer traps, both in strings, regexes or
 * comments of the code (where they are legal JS):
 *  - `</script` (any case) closes the tag → `<\/script` (the same text in a string, a template or a
 *    regex, with or without the `u` flag);
 *  - `<!--` switches the tokenizer into the escaped state, where a later `<script` makes the REAL
 *    `</script>` no longer close the tag — the rest of the page becomes script text → `\x3C!--`
 *    (the same text in a string, a template or a regex, `u` flag included).
 * (`a <!--b` as an expression — `a < !(--b)` — would no longer parse. Nobody writes it.)
 */
function close_safe(code: string): string {
	let out = '';
	let last = 0;
	for (let i = code.indexOf('<'); i !== -1; i = code.indexOf('<', i + 1)) {
		if (code.startsWith('!--', i + 1)) {
			out += code.slice(last, i) + '\\x3C';
			last = i + 1;
		} else if (code.charCodeAt(i + 1) === 47 /* / */ && code.slice(i + 2, i + 8).toLowerCase() === 'script') {
			out += code.slice(last, i + 1) + '\\';
			last = i + 1;
		}
	}
	return last === 0 ? code : out + code.slice(last);
}

/**
 * A function's source as an EXPRESSION. `toString` of an arrow or a `function` already is one; a
 * method written in the options object (`{ run() { … } }`, `async run()`, `*run()`) is not —
 * `(run() {…})` is a syntax error — so a method is read back out of an object literal:
 * `Object.values({ run() {…} })[0]`.
 */
function fn_source(fn: { toString(): string }): string {
	const src = fn.toString();
	let i = 0;
	if (src.startsWith('async')) {
		let j = 5;
		while (is_ws(src.charCodeAt(j))) j++;
		if (src.startsWith('=>', j)) return src; // `async => …`: a parameter named async
		if (src.charCodeAt(j) === 40 /* ( */) {
			// `async (…) => …` (arrow) or `async(…) {…}` (a method named async)
			return src.startsWith('=>', skip_ws(src, after_parens(src, j))) ? src : `Object.values({${src}})[0]`;
		}
		if (j === 5) return `Object.values({${src}})[0]`; // `asyncX(…) {…}`: a method
		i = j;
	}
	if (src.startsWith('function', i) && !is_ident(src.charCodeAt(i + 8))) return src;
	const c = src.charCodeAt(i);
	if (c === 40 /* ( */) return src; // `(…) => …`
	if (is_ident(c)) {
		let j = i;
		while (is_ident(src.charCodeAt(j))) j++;
		if (src.startsWith('=>', skip_ws(src, j))) return src; // `x => …`
	}
	return `Object.values({${src}})[0]`; // a method: `name(…)`, `*name(…)`, `'name'(…)`, `[k](…)`
}

function is_ws(c: number): boolean {
	return c === 32 || c === 9 || c === 10 || c === 13;
}

function is_ident(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;
}

function skip_ws(s: string, i: number): number {
	while (is_ws(s.charCodeAt(i))) i++;
	return i;
}

/** The index after the `)` that closes the `(` at `open` — strings skipped, nesting counted. */
function after_parens(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 34 || c === 39 || c === 96) {
			for (i++; i < s.length && s.charCodeAt(i) !== c; i++) if (s.charCodeAt(i) === 92) i++;
		} else if (c === 40) depth++;
		else if (c === 41 && --depth === 0) return i + 1;
	}
	return s.length;
}

/** An HTML attribute name we will write: letters, digits, `-`, `_`, `:`, `.`, starting with a letter. */
function is_attr_name(s: string): boolean {
	if (s.length === 0) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const letter = (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
		if (letter) continue;
		if (i === 0) return false;
		if ((c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58 || c === 46) continue;
		return false;
	}
	return true;
}
