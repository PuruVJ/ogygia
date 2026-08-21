/**
 * `import.meta.og.bake(fn)` — run `fn` at BUILD, serialize its result, inline it as a constant.
 *
 *   const nav = import.meta.og.bake(() => buildNav());   // → const nav = {…the computed tree…}
 *
 * At build the macro bundles `fn` together with the module's imports (rolldown, aliases resolved),
 * executes the bundle in Node, `devalue.uneval`s the result, and rewrites the call to that literal.
 * At runtime there is no function and no work — just the answer, even in client code. "Run at build,
 * ship the answer." Content-addressed, so an unchanged `fn` (same source + same imports) re-bakes
 * only when its inputs change.
 *
 * The CONTRACT (like Bun's macros): `fn` is self-contained — it may use the module's IMPORTS and
 * literals, and `await` freely, but must not close over the module's other local variables (the
 * eval bundle carries the imports, not the surrounding scope). Its result must be devalue-serializable
 * (JSON + Date/Map/Set/RegExp/BigInt/…): a function or Promise in the result is a build error. Both
 * violations surface as build-voice errors naming the file and line. Node-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { uneval } from 'devalue';
import { og_member } from './wire.js';
import { parse_module } from '../parse/oxc.js';
import { og_js_regions } from '../parse/scan.js';
import { BuildCache } from '../../build-cache.js';

/** bake's corner of the shared build cache — the transient eval bundles live here (never committed;
 *  written and deleted per bake). All writes go through the cache interface, like the git checkouts. */
const bake_cache = new BuildCache<never>('bake');

const MARKER = 'import.meta.og.bake';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

export type AliasEntry = { find: string | RegExp; replacement: string };

function walk(node: Node, visit: (n: Node) => void): void {
	visit(node);
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (const c of child)
				if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, visit);
		} else if (child && typeof child === 'object' && typeof child.type === 'string') {
			walk(child, visit);
		}
	}
}

function line_of(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
	return line;
}

/** One located bake() call: the span to replace and the verbatim `fn` argument text. */
type BakeCall = { start: number; end: number; fn: string };

/** One import declaration: its span (for removal) and the local names it binds. */
type ImportDecl = { start: number; end: number; text: string; names: string[] };

/**
 * Collect import declarations (with bound names) and every bake() call across the module's JS
 * regions — whole file for `.ts`/`.js`, each `<script>` block for `.svelte`. All spans are ABSOLUTE
 * (offset-mapped from each region into `src`), so an edit splices straight into `src`. Returns null
 * when no region parses (a half-typed file waits). `markup_exts` is the construct-host set.
 */
function scan(
	src: string,
	id: string,
	markup_exts: readonly string[]
): { imports: ImportDecl[]; calls: BakeCall[] } | null {
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return null;
	const imports: ImportDecl[] = [];
	const calls: BakeCall[] = [];
	let any = false;
	for (const region of regions) {
		const { program, ok } = parse_module(region.code, id);
		if (!ok || !program) continue;
		any = true;
		const off = region.offset;
		for (const n of (program.body as Node[]) ?? []) {
			if (n.type !== 'ImportDeclaration') continue;
			const names: string[] = [];
			for (const s of (n.specifiers as Node[] | undefined) ?? []) {
				if (s.local?.name) names.push(s.local.name as string);
			}
			imports.push({
				start: off + n.start,
				end: off + n.end,
				text: region.code.slice(n.start, n.end),
				names
			});
		}
		walk(program, (n) => {
			if (n.type !== 'CallExpression' || og_member(n.callee as Node) !== 'bake') return;
			const abs = off + n.start;
			const args = (n.arguments as Node[] | undefined) ?? [];
			if (args.length !== 1) {
				throw new Error(
					`[ogygia] ${id}:${line_of(src, abs)} — import.meta.og.bake(fn) takes exactly one argument (a function).`
				);
			}
			const a = args[0]!;
			if (a.type !== 'ArrowFunctionExpression' && a.type !== 'FunctionExpression') {
				throw new Error(
					`[ogygia] ${id}:${line_of(src, abs)} — import.meta.og.bake(fn): the argument must be a function (\`() => …\`).`
				);
			}
			calls.push({ start: abs, end: off + n.end, fn: region.code.slice(a.start, a.end) });
		});
	}
	return any ? { imports, calls } : null;
}

/** The imports the EVAL bundle needs: those whose bound name appears (word-boundary) in some bake
 *  fn. Excludes everything the fns don't use — crucially a `.svelte`'s component imports, which
 *  rolldown couldn't execute anyway. */
function eval_imports(imports: ImportDecl[], calls: BakeCall[]): ImportDecl[] {
	const fnText = calls.map((c) => c.fn).join('\n');
	return imports.filter((imp) =>
		imp.names.some((name) =>
			new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(fnText)
		)
	);
}

/**
 * Which imports become UNUSED once every bake call is replaced by its result? An import is removable
 * when none of its bound names appears anywhere OUTSIDE the import statements and the bake spans — so
 * the binding was used only to feed a baked function. Over-conservative on purpose (a word-boundary
 * text scan of the remainder counts property keys / strings as uses too): it may KEEP a truly-dead
 * import, never REMOVE a live one. A kept-but-dead import just tree-shakes in the final bundle; a
 * wrongly-removed one would break the module.
 */
function dead_imports(src: string, imports: ImportDecl[], calls: BakeCall[]): ImportDecl[] {
	// Build the "remainder": source with every import decl and every bake call blanked to spaces
	// (spaces preserve offsets and can't create spurious word matches).
	const blanks: Array<[number, number]> = [
		...imports.map((i) => [i.start, i.end] as [number, number]),
		...calls.map((c) => [c.start, c.end] as [number, number])
	].sort((a, b) => a[0] - b[0]);
	let remainder = '';
	let last = 0;
	for (const [s, e] of blanks) {
		remainder += src.slice(last, s) + ' '.repeat(e - s);
		last = e;
	}
	remainder += src.slice(last);

	return imports.filter(
		(imp) =>
			imp.names.length > 0 &&
			imp.names.every((name) => {
				const re = new RegExp(
					`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`
				);
				return !re.test(remainder);
			})
	);
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json'];
const INDEX_EXTS = [
	'/index.ts',
	'/index.mts',
	'/index.js',
	'/index.mjs',
	'/index.jsx',
	'/index.tsx'
];

/** Resolve a relative specifier against `dir` to an existing absolute FILE path (extension/`index`
 *  probing), or null. */
function resolve_relative(dir: string, source: string): string | null {
	return resolve_file(path.resolve(dir, source));
}

/**
 * The rolldown plugin that serves the virtual eval entry and roots resolution at the REAL module's
 * directory. It resolves — WITH extension probing, so an extensionless TS import lands on `x.ts` —
 * the entry's relative imports (`./data`) against `module_dir`, its `$lib/…` against `<root>/src/lib`
 * (the SvelteKit convention, robust even if the config alias isn't populated yet), and any configured
 * alias. Anything a resolved module then pulls in has a real path and resolves normally.
 */
function bake_plugin(
	entry_id: string,
	entry_code: string,
	module_dir: string,
	root: string,
	aliases: AliasEntry[]
) {
	return {
		name: 'ogygia-bake-entry',
		resolveId(source: string, importer: string | undefined) {
			if (source === entry_id) return entry_id;
			const from_entry = importer === entry_id || importer === undefined;
			// Configured aliases (probe the extension on the result so `$lib/x` → `x.ts`).
			for (const { find, replacement } of aliases) {
				let mapped: string | null = null;
				if (typeof find === 'string') {
					if (source === find) mapped = replacement;
					else if (source.startsWith(find + '/'))
						mapped = path.join(replacement, source.slice(find.length + 1));
				} else if (find.test(source)) {
					mapped = source.replace(find, replacement);
				}
				if (mapped) return resolve_file(mapped) ?? mapped;
			}
			// SvelteKit conventions, as a fallback (config aliases may be unset this early).
			if (source === '$lib' || source.startsWith('$lib/')) {
				return resolve_file(
					path.join(root, 'src', 'lib', source.slice('$lib'.length).replace(/^\//, ''))
				);
			}
			// The entry's relative imports resolve against the real module's directory.
			if (from_entry && (source.startsWith('./') || source.startsWith('../'))) {
				return resolve_relative(module_dir, source);
			}
			return null; // node_modules + nested relatives resolve via rolldown (real paths / cwd)
		},
		load(id: string) {
			return id === entry_id ? entry_code : null;
		}
	};
}

/** Probe an absolute path base to an existing file (extension / `index`), or null. */
function resolve_file(base: string): string | null {
	for (const e of RESOLVE_EXTS) {
		const f = base + e;
		try {
			if (fs.statSync(f).isFile()) return f;
		} catch {
			/* not this ext */
		}
	}
	for (const e of INDEX_EXTS) {
		const f = base + e;
		try {
			if (fs.statSync(f).isFile()) return f;
		} catch {
			/* not this index */
		}
	}
	return null;
}

/**
 * Bundle + execute the eval entry, returning the array of results (one per bake call). Isolated in a
 * fresh module URL each time so Node's ESM cache never serves a stale bake.
 */
async function evaluate(entry_code: string, id: string, opts: BakeOptions): Promise<unknown[]> {
	const { rolldown } = await import('rolldown');
	const ENTRY = '\0ogygia-bake-entry.js';
	const module_dir = path.dirname(id.split('?')[0]!);
	const bundle = await rolldown({
		input: ENTRY,
		cwd: module_dir,
		plugins: [bake_plugin(ENTRY, entry_code, module_dir, opts.root, opts.alias)],
		platform: 'node',
		// Probe TS/JS extensions so an alias/tsconfig-path (`$lib/x`) or bare relative resolves to
		// `x.ts` etc. — the app corpus is TypeScript with extensionless imports.
		resolve: { extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.json', '.node'] },
		// Node builtins resolve at runtime; everything else (app TS, npm deps) is bundled in, so the
		// emitted file is self-contained and its location doesn't affect resolution.
		external: (source: string) => source.startsWith('node:'),
		logLevel: 'silent'
	});
	try {
		const { output } = await bundle.generate({ format: 'esm', exports: 'named' });
		const code = output[0]!.code;
		// The eval bundle is written through the cache interface (`BuildCache('bake').dir()`) — the
		// same managed directory the git checkouts use — then imported and deleted.
		const dir = bake_cache.dir();
		if (!dir)
			throw new Error(
				'the build cache (node_modules/.ogygia) is unavailable — cannot stage the bake bundle'
			);
		const file = path.join(dir, `${opts.hash}.mjs`);
		fs.writeFileSync(file, code);
		try {
			const mod = (await import(pathToFileURL(file).href + `?t=${opts.hash}`)) as {
				__run?: () => Promise<unknown[]>;
			};
			if (typeof mod.__run !== 'function')
				throw new Error('bake eval module produced no __run export');
			return await mod.__run();
		} finally {
			fs.rmSync(file, { force: true });
		}
	} finally {
		await bundle.close();
	}
}

export type BakeOptions = {
	/** Content hash of the eval entry — names/isolates the bundle in the cache. */
	hash: string;
	/** `resolve.alias` entries so a baked `fn` can import `$lib/…`. */
	alias: AliasEntry[];
	/** Project root — anchors the `$lib` convention fallback. */
	root: string;
};

/**
 * Rewrite every `import.meta.og.bake(fn)` in `src` to its inlined, devalue-serialized result. ASYNC
 * (bundles + executes). Returns the input unchanged (same reference) when there is nothing to do.
 * Throws build-voice on a non-serializable result or an `fn` that references non-imported scope.
 */
export async function rewrite_bake(
	src: string,
	id: string,
	opts: Omit<BakeOptions, 'hash'> & { markupExts?: readonly string[] }
): Promise<string> {
	if (!src.includes(MARKER)) return src;
	const found = scan(src, id, opts.markupExts ?? ['.svelte']);
	if (!found || !found.calls.length) return src;

	// The eval entry: only the imports the bake fns actually use (so a `.svelte`'s component imports
	// never enter the Node bundle), then a `__run` that awaits every bake fn in order.
	const runners = found.calls.map((c, i) => `		r[${i}] = await (${c.fn})();`).join('\n');
	const entry_code =
		eval_imports(found.imports, found.calls)
			.map((i) => i.text)
			.join('\n') +
		`\nexport async function __run() {\n\tconst r = [];\n${runners}\n\treturn r;\n}\n`;

	// Content hash: module id + the exact eval entry (imports + fns) → address the bundle & re-bake
	// only when inputs change.
	const hash = hash_of(id + '\0' + entry_code);

	let results: unknown[];
	try {
		results = await evaluate(entry_code, id, { ...opts, hash });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(
			`[ogygia] import.meta.og.bake() in ${path.basename(id)}: evaluating the function failed — ${msg}. ` +
				`A baked function may use this module's IMPORTS and literals only (not its other local variables), ` +
				`and must not touch runtime-only modules ($app/*, the browser).`
		);
	}

	// Serialize each result; also drop imports that only fed a baked fn (so the computation's
	// server-only deps don't linger in the graph). Both are span edits, interleaved in offset order.
	const edits: Array<{ start: number; end: number; text: string }> = [];
	found.calls.forEach((c, i) => {
		let literal: string;
		try {
			literal = uneval(results[i]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(
				`[ogygia] ${id}:${line_of(src, c.start)} — import.meta.og.bake(): the result is not serializable (${msg}). ` +
					`bake produces DATA — return plain values (JSON + Date/Map/Set/RegExp/BigInt), never a function, Promise, or class instance.`
			);
		}
		edits.push({ start: c.start, end: c.end, text: `(${literal})` });
	});
	for (const imp of dead_imports(src, found.imports, found.calls)) {
		// Drop the whole declaration line (its trailing newline too, when present).
		const end = src[imp.end] === '\n' ? imp.end + 1 : imp.end;
		edits.push({ start: imp.start, end, text: '' });
	}
	edits.sort((a, b) => a.start - b.start);

	let out = '';
	let last = 0;
	for (const e of edits) {
		out += src.slice(last, e.start) + e.text;
		last = e.end;
	}
	out += src.slice(last);
	return out;
}

/** Stable non-crypto hash (FNV-1a) → hex. Enough to address a bundle by its inputs. */
function hash_of(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
