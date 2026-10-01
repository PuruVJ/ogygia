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
type NoRun = { run?: never; args?: never; type?: never; async?: never; blocking?: never; nomodule?: never };

/** `args` is required exactly when `run` takes parameters. */
type RunArgs<A extends unknown[]> = A extends [] ? { args?: [] } : { args: A };

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
		blocking?: never;
	} & RunArgs<A>;

/**
 * A MODULE inline script: its own scope, strict mode, `import()` available, and runs after the
 * document is parsed. An `async` `run` is awaited (top-level await), so with `blocking: 'render'` the
 * first paint waits for it.
 */
export type ModuleScript<A extends unknown[]> = ScriptAttrs &
	NoPayload & {
		run: (...args: A) => unknown;
		type: 'module';
		/** Run as soon as it is ready, without waiting for the document to finish parsing. */
		async?: boolean;
		/** Hold the first paint until it has run (a module that must apply before anything shows). */
		blocking?: 'render';
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
	| JsonScript
	| LdScript
	| ImportMapScript
	| SpeculationScript;

/** The payload and option keys — everything else in the object is an attribute. */
const RESERVED = new Set(['run', 'args', 'json', 'ld', 'importmap', 'speculation', 'type']);

/**
 * An inline `<script>` tag. Pass a function and its args (shortcut for `{ run: fn, args }`) or one
 * options object; see
 * the module doc. Throws on an object with no payload or more than one, and on an attribute name
 * that is not one.
 */
export function script<A extends unknown[]>(run: (...args: A) => unknown, ...args: A): string;
export function script<A extends unknown[]>(options: ClassicScript<A> | ModuleScript<A>): string;
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
		// A module awaits its `run`: top-level await, so `blocking: 'render'` holds paint for async work.
		body = `${module ? 'await ' : ''}(${close_safe(o.run.toString())})(${call});`;
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

/** `</script` (any case) in code cannot close the tag it lives in: `<\/script` reads the same in JS. */
function close_safe(code: string): string {
	let out = '';
	let last = 0;
	for (let i = code.indexOf('</'); i !== -1; i = code.indexOf('</', i + 2)) {
		if (code.slice(i + 2, i + 8).toLowerCase() !== 'script') continue;
		out += code.slice(last, i + 1) + '\\';
		last = i + 1;
	}
	return last === 0 ? code : out + code.slice(last);
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
