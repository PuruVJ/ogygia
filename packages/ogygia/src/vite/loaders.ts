/**
 * `import.meta.og.loader.*` — the compile surface for STATIC content sources. One consistent rule:
 * a loader call takes a LITERAL glob (or, for `git`, a repo spec) and the macro owns the
 * `import.meta.glob(…, { eager: false })` wrapper. So the app never writes the glob-plumbing itself:
 *
 *   content({ loader: import.meta.og.loader.folder('../content/docs') })      // a DIRECTORY
 *   content({ loader: import.meta.og.loader.markdown('./posts') })             // a DIRECTORY
 *   content({ loader: import.meta.og.loader.json('./authors') })               // a DIRECTORY
 *
 * The blessed argument is a bare directory — each loader derives its own opinionated pattern under
 * it (folder → `+doc.svx` + `+meta.json`; markdown → `*.svx` + `*.md`; json → `*.json`, all
 * recursive). An argument carrying glob magic (`* ? { [`) or a file-looking basename (has a dot) is
 * passed through verbatim — the escape hatch for corpora the convention doesn't fit:
 *
 *   content({ loader: import.meta.og.loader.markdown('./docs/**\/*.svx') })   // explicit glob
 *   content({ loader: import.meta.og.loader.git('sveltejs/svelte@main:documentation/docs') })
 *
 * Each rewrites to the matching runtime builder (`markdown`/`folder`/`json`) wrapping the glob; `git`
 * additionally materializes a shallow checkout first and points the glob at it. The runtime builders
 * still exist — they're the rewrite TARGETS — but taking a raw `import.meta.glob` map is no longer a
 * blessed public entry: anything dynamic is a hand-written {@link Source}. Node-only (materialization).
 *
 * RELIABILITY. Detection is AST-first: `parseSync` (oxc, TS-aware, never throws) finds the real
 * `CallExpression`s, so a marker in a comment or string is provably NOT a call — it isn't a call node
 * in the tree. Only if the parse fails (a `.svelte` file handed here raw, or half-typed source
 * mid-edit) do we fall back to the string scanner, which itself skips strings/comments/regex. Belt
 * and suspenders: the false-positive rewrite the scanner alone could (in theory) make is unreachable
 * whenever the module actually parses — which, for the `.server.ts` files loaders live in, is always.
 */
import { find_og_calls, split_first_string, type OgCall } from './og-lexer.js';
import { parse_git_spec, git_glob_pattern, type GitSpec } from './git.js';
import { parse_module } from './og-parse.js';
import { islandBridge } from './island-bridge.js';

const PREFIX = 'import.meta.og.loader.';

/** loader method → the runtime builder it rewrites to. `git` is special-cased (→ `folder`). */
const BUILDER: Record<string, 'markdown' | 'folder' | 'json'> = {
	markdown: 'markdown',
	folder: 'folder',
	json: 'json'
};

/** Unique aliases so injected builder imports can't collide with the app's own `markdown`/`folder`. */
const ALIAS = { markdown: '__og_markdown', folder: '__og_folder', json: '__og_json' } as const;

export type LoaderCall = OgCall;

/**
 * Expand `{a,b}` brace alternation into concrete patterns (cartesian over multiple/nested groups).
 *
 * WHY: Vite's DEV glob matcher silently drops a brace group whose members start with `+` — the very
 * shape `folder()` leans on (`{+doc.svx,+meta.json}`). It matches every file in the production build
 * (a different matcher) but ZERO in dev, so a whole content collection comes up empty on the dev
 * server while the build is green. Emitting the expanded ARRAY form
 * (`import.meta.glob(['…/+doc.svx','…/+meta.json'], …)`) sidesteps braces entirely, and both matchers
 * agree. Non-brace patterns pass straight through as a single string (unchanged emit).
 */
export function expand_braces(pattern: string): string[] {
	const open = pattern.indexOf('{');
	if (open < 0) return [pattern];
	// Find the matching `}` for THIS `{`, tracking nesting so `{a,{b,c}}` closes correctly.
	let depth = 0;
	let close = -1;
	for (let i = open; i < pattern.length; i++) {
		if (pattern[i] === '{') depth++;
		else if (pattern[i] === '}' && --depth === 0) {
			close = i;
			break;
		}
	}
	if (close < 0) return [pattern]; // unbalanced — leave untouched rather than corrupt it
	// Split this group's options on TOP-LEVEL commas (a nested `{}` keeps its commas).
	const inner = pattern.slice(open + 1, close);
	const options: string[] = [];
	let start = 0;
	depth = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === '{') depth++;
		else if (inner[i] === '}') depth--;
		else if (inner[i] === ',' && depth === 0) {
			options.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	options.push(inner.slice(start));
	const head = pattern.slice(0, open);
	const tail = pattern.slice(close + 1);
	// Recurse so remaining/nested groups expand too; dedupe stays the caller's concern (none arise here).
	return options.flatMap((opt) => expand_braces(head + opt + tail));
}

/** Emit the glob source for a pattern — a plain string when there are no braces, Vite's array form
 *  when brace expansion yields more than one concrete pattern (so dev + build agree). */
function glob_arg(pattern: string): string {
	return glob_arg_list(expand_braces(pattern));
}

function glob_arg_list(patterns: string[]): string {
	return JSON.stringify(patterns.length === 1 ? patterns[0] : patterns);
}

/** Glob magic that marks an argument as an explicit pattern rather than a directory. */
const GLOB_MAGIC = /[*?{}[\]]/;

/**
 * Extract (and STRIP) a `preset: 'name'` property from a loader call's trailing options text.
 *
 * The name must be a LITERAL string (the standing macro-argument law) — it selects a
 * `content.presets` entry at build, so a runtime expression can never carry it. The property is
 * spliced OUT of the options the runtime builder receives: the preset is fully consumed at compile
 * (it becomes the emitted glob's `?og_preset=` module-variant query); a copy reaching runtime would
 * be a silent no-op wearing an option's clothes.
 *
 * Parsing rides the same oxc parser as macro detection: the args text is wrapped as a call and
 * parsed, so a `preset` key nested in some OTHER object (a convention option, a regex) is provably
 * not the loader's own — only a top-level property of the FIRST ObjectExpression argument counts.
 */
export function extract_preset(args: string, context: string): { preset: string | null; args: string } {
	if (!/\bpreset\b/.test(args)) return { preset: null, args };
	const wrapped = `__og(${args})`;
	const { program, ok } = parse_module(wrapped, 'loader-args.ts');
	if (!ok || !program) {
		throw new Error(
			`[ogygia] ${context}: could not parse the options object while looking for \`preset\` — simplify the options, and keep \`preset\` a literal string.`
		);
	}
	// program → ExpressionStatement → CallExpression(args)
	const call = (program as Node).body?.[0]?.expression;
	if (call?.type !== 'CallExpression') return { preset: null, args };
	for (const arg of call.arguments ?? []) {
		if (arg?.type !== 'ObjectExpression') continue;
		for (const prop of arg.properties ?? []) {
			if (prop?.type !== 'Property' && prop?.type !== 'ObjectProperty') continue;
			const key = prop.key?.name ?? prop.key?.value;
			if (key !== 'preset') continue;
			const v = prop.value;
			const literal =
				(v?.type === 'Literal' || v?.type === 'StringLiteral') && typeof v.value === 'string' ? v.value : null;
			if (literal == null) {
				throw new Error(
					`[ogygia] ${context}: \`preset\` must be a literal string ('name') — it selects a content preset at build.`
				);
			}
			// Splice the property (and one neighboring comma) out of the ORIGINAL args text. Offsets in
			// `wrapped` are the args offsets + the `__og(` prefix length.
			const off = '__og('.length;
			let from = prop.start - off;
			let to = prop.end - off;
			const before = args.slice(0, from);
			const after = args.slice(to);
			if (/,\s*$/.test(before)) from = before.lastIndexOf(',');
			else if (/^\s*,/.test(after)) to += after.indexOf(',') + 1;
			const remaining = (args.slice(0, from) + args.slice(to)).trim();
			// `{ preset: 'x' }` was the WHOLE options object → drop it rather than emit `{ }`.
			return { preset: literal, args: /^\{\s*\}$/.test(remaining) ? '' : remaining };
		}
	}
	return { preset: null, args };
}

/** Validate a macro's preset name against the configured dictionary — error lists the real names. */
function check_preset_name(preset: string, context: string): void {
	const dict = islandBridge.contentPresets;
	const names = dict ? Object.keys(dict) : [];
	if (!names.includes(preset)) {
		throw new Error(
			`[ogygia] ${context}: unknown content preset '${preset}'. ${
				names.length
					? `Configured: ${names.join(', ')}.`
					: 'No content presets are configured — define it under ogygia({ content: { presets } }).'
			}`
		);
	}
}

/** The opinionated file set each loader owns, rooted under a directory argument. */
const OPINIONATED: Record<'markdown' | 'folder' | 'json', string[]> = {
	folder: ['**/+doc.svx', '**/+meta.json'],
	markdown: ['**/*.svx', '**/*.md'],
	json: ['**/*.json']
};

/**
 * Resolve a loader argument to concrete glob patterns. A bare DIRECTORY (no glob magic, basename
 * without a dot) gets the loader's opinionated set under it — the blessed authoring form. Anything
 * else (explicit glob, or a file-looking path) passes through with brace expansion only.
 */
export function loader_patterns(builder: 'markdown' | 'folder' | 'json', raw: string): string[] {
	if (GLOB_MAGIC.test(raw)) return expand_braces(raw);
	const dir = raw.replace(/\/+$/, '');
	const base = dir.slice(dir.lastIndexOf('/') + 1);
	if (base.includes('.') && !/^\.+$/.test(base)) return [raw]; // a single file — leave it alone
	return OPINIONATED[builder].map((p) => `${dir}/${p}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

/** Is this callee the member chain `import.meta.og.loader.<method>`? Returns the method or null. */
function loader_method(callee: Node | undefined): string | null {
	// callee = MemberExpression(object = …og.loader, property = <method>)
	if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null;
	const method = callee.property?.name;
	if (typeof method !== 'string') return null;
	// walk down: .loader → .og → import.meta
	const loader = callee.object;
	if (loader?.type !== 'MemberExpression' || loader.computed || loader.property?.name !== 'loader') return null;
	const og = loader.object;
	if (og?.type !== 'MemberExpression' || og.computed || og.property?.name !== 'og') return null;
	const meta = og.object;
	// oxc/estree: `import.meta` is a MetaProperty { meta: {name:'import'}, property: {name:'meta'} }
	if (meta?.type !== 'MetaProperty' || meta.meta?.name !== 'import' || meta.property?.name !== 'meta') return null;
	return method;
}

/** Depth-first walk of an oxc AST, visiting every node object. */
function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (const c of child) if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, visit);
		} else if (child && typeof child === 'object' && typeof child.type === 'string') {
			walk(child, visit);
		}
	}
}

/** AST-precise loader-call finder. Returns null when the source doesn't parse (caller falls back). */
function find_via_ast(src: string, id: string): LoaderCall[] | null {
	const { program, ok } = parse_module(src, id);
	if (!ok || !program) return null;
	const calls: LoaderCall[] = [];
	walk(program, (n) => {
		if (n.type !== 'CallExpression') return;
		const method = loader_method(n.callee as Node | undefined);
		if (method == null) return;
		// `args` = the VERBATIM text between the parens, so `emit()` (via split_first_string) treats an
		// AST hit and a scanner hit identically. The open paren is the first `(` after the callee.
		const open = src.indexOf('(', (n.callee as Node).end);
		if (open < 0 || open >= n.end) return;
		calls.push({ start: n.start, end: n.end, method, args: src.slice(open + 1, n.end - 1) });
	});
	// Source order — the rewrite splices by ascending offset.
	calls.sort((a, b) => a.start - b.start);
	return calls;
}

/**
 * Locate every `import.meta.og.loader.<name>(…)` call. AST-first (provably no comment/string false
 * positives); the string scanner is the fallback for source that doesn't parse. `id` names the module
 * for the parser (extension picks the dialect). Pure — no materialization.
 */
export function find_loader_calls(src: string, id = 'module.ts'): LoaderCall[] {
	if (!src.includes(PREFIX)) return [];
	return find_via_ast(src, id) ?? find_og_calls(src, PREFIX);
}

/**
 * Rewrite every `import.meta.og.loader.*` call to its runtime-builder expression and inject the
 * (aliased) builder imports. Returns the new code + the git specs to materialize (empty when no
 * `git` loader is present). Pure — the rewritten CODE never depends on a checkout, so the plugin
 * materializes the returned specs separately, before Vite's glob plugin scans the emitted pattern.
 */
export function rewrite_loaders(src: string, id = 'module.ts'): { code: string; specs: GitSpec[] } {
	const calls = find_loader_calls(src, id);
	if (!calls.length) return { code: src, specs: [] };

	const used = new Set<'markdown' | 'folder' | 'json'>();
	const specs: GitSpec[] = [];
	let out = '';
	let last = 0;

	for (const c of calls) {
		out += src.slice(last, c.start);
		out += emit(c, used, specs);
		last = c.end;
	}
	out += src.slice(last);

	const imports = [...used].sort().map((b) => `${b} as ${ALIAS[b]}`).join(', ');
	const header = imports ? `import { ${imports} } from 'ogygia/content';\n` : '';
	return { code: header + out, specs };
}

/** The emitted `import.meta.glob` options — a preset mints module VARIANTS via a custom query, so
 *  the same file under two presets is two modules, each compiled with its own merged config. */
function glob_opts(preset: string | null): string {
	return preset ? `{ eager: false, query: { og_preset: ${JSON.stringify(preset)} } }` : '{ eager: false }';
}

/** One loader call → its rewritten expression. Mutates `used`/`specs` with what it needs. */
function emit(c: LoaderCall, used: Set<'markdown' | 'folder' | 'json'>, specs: GitSpec[]): string {
	const context = `import.meta.og.loader.${c.method}()`;
	if (c.method === 'git') {
		const { value, rest } = split_first_string(c.args, context);
		const spec = parse_git_spec(value);
		specs.push(spec);
		used.add('folder');
		const { preset, args: clean } = extract_preset(rest ?? '', context);
		if (preset) check_preset_name(preset, context);
		const opts = clean ? `, ${clean}` : '';
		return `${ALIAS.folder}(import.meta.glob(${glob_arg(git_glob_pattern(spec))}, ${glob_opts(preset)})${opts})`;
	}

	const builder = BUILDER[c.method];
	if (!builder) {
		throw new Error(
			`[ogygia] import.meta.og.loader.${c.method}() is not a loader — expected markdown, folder, json, or git.`
		);
	}
	const { value: glob, rest } = split_first_string(c.args, context);
	used.add(builder);
	const { preset, args: clean } = extract_preset(rest ?? '', context);
	if (preset) check_preset_name(preset, context);
	const opts = clean ? `, ${clean}` : '';
	return `${ALIAS[builder]}(import.meta.glob(${glob_arg_list(loader_patterns(builder, glob))}, ${glob_opts(preset)})${opts})`;
}
