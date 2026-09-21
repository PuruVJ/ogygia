/**
 * WHICH `page.data` KEYS does a module read? — the static analysis behind seed shaping.
 *
 * The page seed (`application/ogygia-page`) exists so an island can read `$page` through the shim,
 * and it used to be all-or-nothing: one island reading `page.data._locale` shipped the whole
 * `page.data` (368 KB on a measured CMS home page, 199 KB of it a header entry no island ever
 * touched). This analysis reads a module ONCE, at transform time, on the compiler's own parsers —
 * oxc for `.ts` / `.js`, Svelte's for `.svelte` (both scripts and the template's expressions) —
 * resolves the `page` binding through its aliases, and answers with the set of top-level
 * `page.data` keys the module can reach. The build unions the answers over an island's chunk
 * closure (island-deps.ts) and the handle ships only those keys.
 *
 * CONSERVATIVE BY CONSTRUCTION. Any read the analysis cannot resolve to a literal key — `page.data`
 * handed to a function, aliased whole, indexed with a variable, spread, `page.subscribe(...)`, a
 * namespace import, the whole page passed on — answers `'all'`, and the seed ships whole as
 * before. A wrong `'all'` costs bytes; a wrong key set would cost an island its data, so every
 * doubt goes to `'all'`.
 */
import { parse } from 'svelte/compiler';
import { fs } from '../host.js';
import { parse_module } from '../parse/oxc.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

export type PageKeys = ReadonlySet<string> | 'all';

/** Kit's page-store specifiers as an author writes them; the driver's shim rewrite runs after
 *  this analysis, so the source still names them. */
const PAGE_SPECIFIER_RE = /^\$app\/(?:state|stores)$/;
/** The page fields that are never shaped — reading them commits nothing about `data`. */
const SAFE_FIELDS = new Set(['url', 'params', 'route', 'status', 'error', 'form', 'state']);
/** Keys the walker never descends into (positions, back-references). */
const SKIP_KEYS = new Set(['start', 'end', 'loc', 'range', 'parent', 'metadata', 'leadingComments', 'trailingComments']);
/** Cheap pre-filter for the transform hot path: no page specifier in the text → nothing to parse. */
const PAGE_SPECIFIER_HINT_RE = /\$app\/st(?:ate|ores)/;

/** The analysis giving up on a module: WHY, and WHERE (a source offset), so the build can name the
 *  line that makes a page ship all of `page.data`. */
class All extends Error {
	constructor(
		public readonly why: string,
		public readonly at: number | null
	) {
		super(why);
	}
}

/** `'all'` with its reason: which construct, at which line. */
export type AllReason = { why: string; line: number | null };

/**
 * A call that hands the page to an IMPORTED helper: `getParams(page)`. The module alone cannot say
 * what the helper reads; the build resolves the specifier, summarizes the helper's export
 * ({@link summarize_export}) and folds the answer in — one level deep. A CMS app passed the page
 * to one `url`-reading helper from 149 modules; following the call pins all of them.
 */
export type PendingCall = { specifier: string; imported: string; arg: number; line: number | null };

export type PageKeysAnswer = { keys: PageKeys | null; reason: AllReason | null; pending: PendingCall[] };

/**
 * The top-level `page.data` keys a module reads, or `'all'` when a read cannot be pinned to a
 * literal key, or `null` when the module never imports the page (nothing to ship for it).
 * `kind` picks the parser: `'svelte'` for a component source, `'script'` for `.ts` / `.js`.
 */
export function page_data_keys(code: string, id: string, kind: 'svelte' | 'script'): PageKeys | null {
	return page_data_keys_answer(code, id, kind).keys;
}

/** The same answer with the reason an `'all'` was given (for the build report). */
export function page_data_keys_answer(code: string, id: string, kind: 'svelte' | 'script'): PageKeysAnswer {
	if (!PAGE_SPECIFIER_HINT_RE.test(code)) return { keys: null, reason: null, pending: [] };
	const roots = parse_roots(code, id, kind);
	if (!roots) return { keys: 'all', reason: { why: 'the module did not parse here (the bundler will say why)', line: null }, pending: [] };
	const scan = new Scan(code);
	try {
		for (const root of roots) scan.collect_bindings(root);
		if (!scan.refs.size) return { keys: null, reason: null, pending: [] };
		for (const root of roots) scan.walk(root, null, null);
		return { keys: scan.keys, reason: null, pending: scan.pending };
	} catch (e) {
		if (e instanceof All) return { keys: 'all', reason: { why: e.why, line: e.at === null ? null : line_of(code, e.at) }, pending: [] };
		throw e;
	}
}

/**
 * What an exported helper reads of a page handed to it as its `arg`-th parameter — the bundle-time
 * half of following `helper(page)`. `'all'` when the export is not a plain function (a re-export,
 * a class, a variable the analysis cannot follow), when the parameter is not a plain name, or when
 * the helper itself hands the page on (one level only).
 */
export type ExportSummary = PageKeys | { follow: string[]; imported: string };

export function summarize_export(code: string, id: string, kind: 'svelte' | 'script', name: string, arg: number): ExportSummary {
	const roots = parse_roots(code, id, kind);
	if (!roots) return 'all';
	let fn: Node | null = null;
	// a re-export (`export { name } from './x'`, `export * from './x'`, or a local binding imported
	// from elsewhere and exported by name): the build follows it to the module that declares it
	let named_follow: string | null = null; // an exact re-export of `name` — wins over every `export *`
	const stars: string[] = [];
	let imported = name;
	const local_fns = new Map<string, Node>();
	const imports = new Map<string, { specifier: string; imported: string }>();
	for (const root of roots) {
		visit(root, (node) => {
			if (node.type === 'FunctionDeclaration' && node.id?.name && !enclosing_scope(node)) local_fns.set(node.id.name, node);
			if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') && !enclosing_scope(node)) local_fns.set(node.id.name, node.init);
			if (node.type === 'ImportDeclaration') for (const s of node.specifiers ?? []) if (s.type === 'ImportSpecifier') imports.set(s.local.name, { specifier: String(node.source?.value ?? ''), imported: spec_name(s.imported) ?? s.local.name });
			if (node.type === 'ExportAllDeclaration' && node.source) stars.push(String(node.source.value));
			if (node.type !== 'ExportNamedDeclaration') return;
			for (const s of node.specifiers ?? []) {
				if (spec_name(s.exported) !== name) continue;
				const local = spec_name(s.local) ?? name;
				if (node.source) {
					named_follow = String(node.source.value);
					imported = local;
				} else if (local_fns.has(local)) fn = local_fns.get(local)!;
				else if (imports.has(local)) {
					named_follow = imports.get(local)!.specifier;
					imported = imports.get(local)!.imported;
				}
			}
			const d = node.declaration;
			if (!d) return;
			if (d.type === 'FunctionDeclaration' && d.id?.name === name) fn = d;
			if (d.type === 'VariableDeclaration') {
				for (const v of d.declarations ?? []) {
					if (v.id?.type === 'Identifier' && v.id.name === name && v.init && (v.init.type === 'ArrowFunctionExpression' || v.init.type === 'FunctionExpression')) fn = v.init;
				}
			}
		});
		if (fn) break;
	}
	if (!fn) {
		if (named_follow) return { follow: [named_follow], imported };
		return stars.length ? { follow: stars, imported } : 'all';
	}
	const param = (fn as Node).params?.[arg];
	if (!param || param.type !== 'Identifier') return 'all';
	const scan = new Scan(code);
	try {
		scan.seed_param(param.name, fn as Node);
		scan.walk((fn as Node).body, fn, 'body');
		if (scan.pending.length) return 'all'; // depth one: the helper handing the page on is not followed
		return scan.keys;
	} catch (e) {
		if (e instanceof All) return 'all';
		throw e;
	}
}

function line_of(code: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
	return line;
}

/** Climb out of the wrappers TypeScript and the parsers put around an expression without
 *  changing what it is: `(page as any)`, `page!`, `page satisfies T`, `(page)`, an optional chain. */
const WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'ChainExpression']);
function unwrap_up(node: Node): { node: Node; parent: Node | null; key: string | null } {
	let cur = node;
	let parent = cur.__parent as Node | null;
	let key = cur.__key as string | null;
	while (parent && WRAPPERS.has(parent.type) && key === 'expression') {
		cur = parent;
		parent = cur.__parent as Node | null;
		key = cur.__key as string | null;
	}
	return { node: cur, parent, key };
}

/** Union two answers: `'all'` absorbs everything, `null` is the identity. */
export function merge_page_keys(a: PageKeys | null, b: PageKeys | null): PageKeys | null {
	if (a === 'all' || b === 'all') return 'all';
	if (!a) return b;
	if (!b) return a;
	return new Set([...a, ...b]);
}

/** Does this module even mention a page-store specifier? (the transform's pre-filter) */
export function mentions_page_store(code: string): boolean {
	return PAGE_SPECIFIER_HINT_RE.test(code);
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────

export function parse_roots(code: string, id: string, kind: 'svelte' | 'script'): Node[] | null {
	if (kind === 'script') {
		const r = parse_module(code, id);
		return r.ok && r.program ? [r.program] : null;
	}
	let ast: any;
	try {
		// The component's `<style>` is preprocessor territory (SCSS `//` comments, nesting) that
		// Svelte's parser rejects before any preprocessor ran — and a stylesheet never reads the page.
		// Blank its inside (same length, offsets kept) and parse the scripts and the template.
		ast = parse(blank_styles(code), { modern: true, filename: id });
	} catch {
		return null;
	}
	const roots: Node[] = [];
	if (ast.module?.content) roots.push(ast.module.content);
	if (ast.instance?.content) roots.push(ast.instance.content);
	if (ast.fragment) roots.push(ast.fragment);
	return roots;
}

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
/** Replace the inside of every `<style>` with spaces (newlines kept, so line numbers hold). */
function blank_styles(code: string): string {
	return code.replace(STYLE_BLOCK_RE, (m, inner: string) => m.slice(0, m.length - inner.length - 8) + inner.replace(/[^\n]/g, ' ') + '</style>');
}

// ── the analysis ───────────────────────────────────────────────────────────────────────────────

/** Function-like nodes: the scopes an alias lives in. */
const SCOPE_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassMethod', 'MethodDefinition', 'PropertyDefinition', 'Program', 'Fragment', 'Root']);

class Scan {
	/** Every name that IS the page: import locals (module-wide), whole-page aliases and
	 *  derived/subscribe params (each valid inside the function that declares it — an unrelated
	 *  `value` in another method is not the page just because one method aliased it so). */
	readonly refs = new Set<string>();
	readonly #scopes = new Map<string, Set<Node | null>>(); // name → declaring scopes (null = module)
	readonly keys = new Set<string>();
	/** Calls handing the page to an imported helper, for the build to follow (see PendingCall). */
	readonly pending: PendingCall[] = [];
	/** Import bindings of this module: local name → what and from where. */
	readonly #imports = new Map<string, { specifier: string; imported: string }>();
	/** Module-level function declarations by name (`function f(p) {}` / `const f = (p) => …`). */
	readonly #local_fns = new Map<string, Node>();

	constructor(private readonly code: string) {}

	/** For {@link summarize_export}: the helper's own parameter IS the page, inside the helper. */
	seed_param(name: string, fn: Node): void {
		this.#add_ref(name, fn.body ?? fn);
		// the scope of a parameter is the function itself: register under the function node
		const scopes = this.#scopes.get(name)!;
		scopes.add(fn);
	}

	#add_ref(name: string, at: Node | null): boolean {
		const scope = at ? enclosing_scope(at) : null;
		let scopes = this.#scopes.get(name);
		if (!scopes) this.#scopes.set(name, (scopes = new Set()));
		if (scopes.has(scope)) return false;
		scopes.add(scope);
		this.refs.add(name);
		return true;
	}

	/** Is `name`, used at `use`, one of the page's names in scope there? */
	#in_scope(name: string, use: Node): boolean {
		const scopes = this.#scopes.get(name);
		if (!scopes) return false;
		if (scopes.has(null)) return true;
		for (let n: Node | null = use; n; n = n.__parent as Node | null) if (scopes.has(n)) return true;
		return false;
	}

	/** Pass 1: bindings. Imports, then aliases grown to a fixed point (an alias of an alias). */
	collect_bindings(root: Node): void {
		visit(root, (node) => {
			// module-level functions a `helper(page)` call can be followed into without leaving the file
			if (node.type === 'FunctionDeclaration' && node.id?.name && !enclosing_scope(node)) this.#local_fns.set(node.id.name, node);
			if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init && (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') && !enclosing_scope(node)) this.#local_fns.set(node.id.name, node.init);
			if (node.type !== 'ImportDeclaration') return;
			const specifier = String(node.source?.value ?? '');
			for (const s of node.specifiers ?? []) {
				if (s.type === 'ImportSpecifier') this.#imports.set(s.local.name, { specifier, imported: spec_name(s.imported) ?? s.local.name });
				else if (s.type === 'ImportDefaultSpecifier') this.#imports.set(s.local.name, { specifier, imported: 'default' });
			}
			if (!PAGE_SPECIFIER_RE.test(specifier)) return;
			for (const s of node.specifiers ?? []) {
				if (s.type === 'ImportNamespaceSpecifier' || s.type === 'ImportDefaultSpecifier')
					throw new All('the page store is imported as a namespace', s.start ?? null);
				if (s.type === 'ImportSpecifier' && spec_name(s.imported) === 'page') this.#add_ref(s.local.name, null);
			}
		});
		if (!this.refs.size) return;
		let grew = true;
		while (grew) {
			grew = false;
			visit(root, (node) => {
				if (node.type === 'VariableDeclarator' && node.init && this.is_page_value(unwrap_down(node.init))) {
					if (node.id?.type === 'Identifier') {
						if (this.#add_ref(node.id.name, node)) grew = true;
					} else {
						// `const { data } = page`, `const [..] = …`: the page taken apart
						throw new All('the page is destructured (`const { data } = page`)', node.start ?? null);
					}
				}
				if (node.type === 'CallExpression') {
					const callee = node.callee;
					const args = node.arguments ?? [];
					// `helper(page)` where helper is a function of THIS module: its parameter is the page
					// inside it, so the walk follows the read there instead of giving up at the call.
					if (callee?.type === 'Identifier' && this.#local_fns.has(callee.name)) {
						const fn = this.#local_fns.get(callee.name)!;
						args.forEach((a: Node, i: number) => {
							if (!this.is_page_value(a)) return;
							const p = fn.params?.[i];
							if (p?.type === 'Identifier') {
								if (this.#add_ref(p.name, fn.body ?? fn)) grew = true;
								this.#scopes.get(p.name)!.add(fn);
							}
						});
					}
					// page.subscribe((p) => …): the subscriber's parameter is the page inside it
					if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'subscribe' && this.is_page_value(callee.object)) {
						const fn = args[0];
						const p = fn?.params?.[0];
						if (fn && p?.type === 'Identifier' && this.#add_ref(p.name, fn.body ?? fn)) {
							this.#scopes.get(p.name)!.add(fn);
							grew = true;
						}
					}
					// derived(page, ($p) => …) / derived([a, page], ([$a, $p]) => …)
					if (callee?.type === 'Identifier' && callee.name === 'derived' && args.length >= 2) {
						const fn = args[1];
						const param = fn?.params?.[0];
						if (args[0]?.type === 'Identifier' && this.is_page_value(args[0])) {
							if (param?.type === 'Identifier') {
								if (this.#add_ref(param.name, fn)) grew = true;
							} else if (param) throw new All('a derived() over the page destructures its parameter', param.start ?? null);
						} else if (args[0]?.type === 'ArrayExpression') {
							args[0].elements.forEach((el: Node, i: number) => {
								if (el?.type !== 'Identifier' || !this.is_page_value(el)) return;
								const p = param?.type === 'ArrayPattern' ? param.elements[i] : null;
								if (p?.type === 'Identifier') {
									if (this.#add_ref(p.name, fn)) grew = true;
								} else throw new All('a derived([…, page, …]) does not name the page parameter', (p ?? el).start ?? null);
							});
						}
					}
				}
			});
		}
	}

	/** Is this expression the page value itself? `page`, `$page`, `get(page)`. */
	is_page_value(raw: Node): boolean {
		const n = unwrap_down(raw);
		if (n.type === 'Identifier') {
			const bare = n.name.startsWith('$') ? n.name.slice(1) : n.name;
			return this.#in_scope(n.name, n) || (bare !== n.name && this.#in_scope(bare, n));
		}
		if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'get') {
			const a = n.arguments?.[0];
			return !!a && a.type === 'Identifier' && this.#in_scope(a.name, a);
		}
		return false;
	}

	/** Pass 2: every use of a page value, judged by its parent. */
	walk(node: Node, parent: Node | null, key: string | null): void {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) this.walk(child, parent, key);
			return;
		}
		if (typeof node.type === 'string' && this.is_page_value(node) && !is_declaration(node, parent, key)) {
			this.judge(node, parent, key);
			if (node.type === 'CallExpression') return; // `get(page)` consumed as a unit
		}
		for (const k of Object.keys(node)) {
			if (SKIP_KEYS.has(k)) continue;
			const v = node[k];
			if (v && typeof v === 'object') this.walk(v, node, k);
		}
	}

	judge(value: Node, raw_parent: Node | null, raw_key: string | null): void {
		// `(page as any).data.x`, `page!.data.x`, `(page).data.x`: the wrapper is not the consumer
		const { node: v, parent, key } = raw_parent && WRAPPERS.has(raw_parent.type) ? unwrap_up(value) : { node: value, parent: raw_parent, key: raw_key };
		const at = value.start ?? null;
		if (!parent) throw new All('the page is used bare', at);
		// `page.<field>` — the one shape that commits nothing (safe field) or a key (`data.x`)
		if (parent.type === 'MemberExpression' && key === 'object') {
			const field = member_name(parent);
			if (field === 'data') {
				this.judge_data(parent);
				return;
			}
			if (field !== null && SAFE_FIELDS.has(field)) return;
			if (field === 'subscribe') {
				// `page.subscribe((p) => …)`: the callback parameter is the page, tracked in pass 1
				const call = parent.__parent as Node | null;
				const fn = call?.type === 'CallExpression' && (parent.__key as string) === 'callee' ? call.arguments?.[0] : null;
				if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') && fn.params?.[0]?.type === 'Identifier') return;
				throw new All('`page.subscribe(…)` hands a subscriber the whole page', at);
			}
			throw new All(field === null ? 'the page is indexed with an expression' : `\`page.${field}\` is read`, at);
		}
		// `const p = page` / `const v = get(page)` — an alias, tracked in pass 1
		if (parent.type === 'VariableDeclarator' && key === 'init') return;
		// `derived(page, …)` / `derived([…, page, …], …)` — the callback param is tracked in pass 1
		if (parent.type === 'CallExpression' && key === 'arguments' && parent.callee?.type === 'Identifier') {
			const name = parent.callee.name;
			if (name === 'derived' || name === 'get') return;
			const fn = this.#local_fns.get(name);
			if (fn) {
				// followed at collect time: the parameter is the page inside the helper
				const i = parent.arguments.indexOf(v);
				if (fn.params?.[i]?.type === 'Identifier') return;
				throw new All(`the whole page is passed to \`${name}(…)\`, whose parameter is destructured`, at);
			}
			const imp = this.#imports.get(name);
			if (imp) {
				// an IMPORTED helper: the build follows the call into that module (summarize_export)
				this.pending.push({ specifier: imp.specifier, imported: imp.imported, arg: parent.arguments.indexOf(v), line: at === null ? null : line_of(this.code, at) });
				return;
			}
			throw new All(`the whole page is passed to \`${name}(…)\``, at);
		}
		if (parent.type === 'ArrayExpression') {
			// only as a `derived([...])` source list
			return;
		}
		// `Object.keys(page)` reads names, never values: nothing of `data` can leave through it
		if (parent.type === 'CallExpression' && key === 'arguments' && parent.callee?.type === 'MemberExpression' && parent.callee.object?.name === 'Object' && parent.callee.property?.name === 'keys') return;
		throw new All('the whole page escapes (passed on, returned, spread, exported or compared)', at);
	}

	/** `page.data` reached: the grandparent decides — a literal key, a destructuring, or all. */
	judge_data(data_member: Node): void {
		let { parent: owner, key: owner_key } = unwrap_up(data_member);
		const at = data_member.start ?? null;
		// `page.data || {}` / `page.data ?? {}`: the fallback is not a read — judge what consumes the
		// whole expression (`const { a, b } = $page?.data || {}` is the common Svelte 4 guard)
		while (owner && owner.type === 'LogicalExpression' && (owner.operator === '||' || owner.operator === '??') && owner_key === 'left') {
			const up = unwrap_up(owner);
			owner = up.parent;
			owner_key = up.key;
		}
		if (!owner) throw new All('`page.data` is used bare', at);
		if (owner.type === 'MemberExpression' && owner_key === 'object') {
			const k = member_name(owner);
			if (k === null) throw new All('`page.data[…]` is indexed with an expression', at);
			this.keys.add(k);
			return;
		}
		if (owner.type === 'VariableDeclarator' && owner_key === 'init' && owner.id?.type === 'ObjectPattern') {
			for (const p of owner.id.properties) {
				if (p.type !== 'Property' || p.computed) throw new All('`page.data` is destructured with a rest or computed key', p.start ?? at);
				const k = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'Literal' ? String(p.key.value) : null;
				if (k === null) throw new All('`page.data` is destructured with a non-literal key', p.start ?? at);
				this.keys.add(k);
			}
			return;
		}
		const how =
			owner.type === 'CallExpression' ? `\`page.data\` is handed whole to ${call_name(owner)}(…)`
			: owner.type === 'VariableDeclarator' ? '`page.data` is aliased whole (`const d = page.data`)'
			: owner.type === 'SpreadElement' ? '`page.data` is spread'
			: owner.type === 'ReturnStatement' || owner.type === 'ArrowFunctionExpression' ? '`page.data` is returned whole'
			: `\`page.data\` is used whole (${owner.type})`;
		throw new All(how, at);
	}
}

/** The nearest function-like ancestor an alias declared at `node` belongs to (`null` = module). */
function enclosing_scope(node: Node): Node | null {
	for (let n = node.__parent as Node | null; n; n = n.__parent as Node | null) {
		if (SCOPE_TYPES.has(n.type)) return n.type === 'Program' || n.type === 'Fragment' || n.type === 'Root' ? null : n;
	}
	return null;
}

/** `(page as any)` → `page`: the expression under TypeScript / parenthesis wrappers. */
function unwrap_down(n: Node): Node {
	let cur = n;
	while (cur && WRAPPERS.has(cur.type) && cur.expression) cur = cur.expression;
	return cur;
}

function call_name(call: Node): string {
	const c = call.callee;
	if (!c) return '?';
	if (c.type === 'Identifier') return c.name;
	if (c.type === 'MemberExpression') return `${c.object?.name ?? '…'}.${c.property?.name ?? '…'}`;
	return '?';
}

/** `a.b` → 'b'; `a['b']` → 'b'; `a[expr]` → null. */
function member_name(m: Node): string | null {
	if (!m.computed) return m.property?.type === 'Identifier' ? m.property.name : null;
	const p = m.property;
	if (p?.type === 'Literal' && typeof p.value === 'string') return p.value;
	if (p?.type === 'TemplateLiteral' && p.expressions?.length === 0) return p.quasis?.[0]?.value?.cooked ?? null;
	return null;
}

function spec_name(n: Node | undefined): string | null {
	if (!n) return null;
	if (n.type === 'Identifier') return n.name;
	if (n.type === 'Literal') return String(n.value);
	return null;
}

/** An identifier in a DECLARING position is not a use of the page value. */
function is_declaration(node: Node, parent: Node | null, key: string | null): boolean {
	if (!parent || node.type !== 'Identifier') return false;
	if (parent.type === 'VariableDeclarator' && key === 'id') return true;
	if (parent.type === 'Property' && key === 'key' && !parent.computed) return true;
	if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
	if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return true;
	if (key === 'params') return true;
	if (parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern' || parent.type === 'AssignmentPattern' || parent.type === 'RestElement') return true;
	if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration') && key === 'id') return true;
	if (parent.type === 'LabeledStatement' && key === 'label') return true;
	return false;
}

/** Generic pre-order visit; annotates each node with its parent and the key it hangs from, which
 *  `judge_data` reads one level up. Arrays are transparent. */
function visit(root: Node, fn: (node: Node) => void): void {
	const rec = (node: Node, parent: Node | null, key: string | null) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) rec(child, parent, key);
			return;
		}
		if (typeof node.type === 'string') {
			Object.defineProperty(node, '__parent', { value: parent, enumerable: false, configurable: true });
			Object.defineProperty(node, '__key', { value: key, enumerable: false, configurable: true });
			fn(node);
		}
		for (const k of Object.keys(node)) {
			if (SKIP_KEYS.has(k)) continue;
			const v = node[k];
			if (v && typeof v === 'object') rec(v, node, k);
		}
	};
	rec(root, null, null);
}

// ── bundle time: following the calls into imported helpers ─────────────────────────────────────

/** How deep a re-export chain the build follows before giving up (a barrel of barrels). */
const FOLLOW_MAX_HOPS = 4;
const SVELTE_EXT_RE = /\.svelte$/;
const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

export type PendingResolver = (specifier: string, importer: string) => Promise<{ id: string } | null | undefined>;

/**
 * For every module with pending `helper(page)` calls: resolve each helper, summarize its export,
 * fold the answer into the module's keys (`'all'` with a reason when the helper cannot be
 * summarized). Runs once per build, before the closure union. `read` and `resolve` are the
 * build's (fs + the bundler's resolver), threaded in so this stays testable.
 */
export async function follow_pending_page_calls(
	program: {
		page_keys: Map<string, PageKeys>;
		page_key_reasons: Map<string, AllReason>;
		page_pending: Map<string, PendingCall[]>;
	},
	resolve: PendingResolver,
	read: (file: string) => string | null = read_file_sync
): Promise<void> {
	const summaries = new Map<string, PageKeys>(); // `${file}#${export}#${arg}` → answer
	for (const [module, calls] of program.page_pending) {
		let keys: PageKeys | null = program.page_keys.get(module) ?? new Set();
		for (const call of calls) {
			if (keys === 'all') break;
			const answer = await summarize_call(call, module, resolve, read, summaries);
			if (answer.keys === 'all') {
				keys = 'all';
				program.page_key_reasons.set(module, { why: `the whole page is passed to \`${call.imported}(…)\` — ${answer.why}`, line: call.line });
				break;
			}
			keys = merge_page_keys(keys, answer.keys) ?? keys;
		}
		program.page_keys.set(module, keys ?? new Set());
	}
	program.page_pending.clear();
}

async function summarize_call(
	call: PendingCall,
	importer: string,
	resolve: PendingResolver,
	read: (file: string) => string | null,
	memo: Map<string, PageKeys>
): Promise<{ keys: PageKeys; why: string }> {
	let specifier = call.specifier;
	let from = importer;
	let name = call.imported;
	for (let hop = 0; hop < FOLLOW_MAX_HOPS; hop++) {
		let resolved: { id: string } | null | undefined;
		try {
			resolved = await resolve(specifier, from);
		} catch {
			resolved = null;
		}
		if (!resolved?.id) return { keys: 'all', why: `\`${specifier}\` could not be resolved from the caller` };
		const file = resolved.id.split('?')[0];
		const memo_key = `${file}#${name}#${call.arg}`;
		const hit = memo.get(memo_key);
		if (hit) return { keys: hit, why: '' };
		const kind = SVELTE_EXT_RE.test(file) ? 'svelte' : SCRIPT_EXT_RE.test(file) ? 'script' : null;
		const code = kind ? read(file) : null;
		if (!kind || code === null) return { keys: 'all', why: `the helper's module (${file}) could not be read` };
		const summary = summarize_export(code, file, kind, name, call.arg);
		if (summary === 'all') return { keys: 'all', why: `\`${name}\` in ${file} hands the page on, or is not a plain function` };
		if (!is_reexport(summary)) {
			memo.set(memo_key, summary);
			return { keys: summary, why: '' };
		}
		// a re-export: follow the first source that declares it (a `export *` fan-out tries each)
		if (summary.follow.length === 1) {
			specifier = summary.follow[0];
			from = file;
			name = summary.imported;
			continue;
		}
		for (const source of summary.follow) {
			const sub = await summarize_call({ ...call, specifier: source, imported: summary.imported }, file, resolve, read, memo);
			if (sub.keys !== 'all') return sub;
		}
		return { keys: 'all', why: `\`${name}\` was not found behind the \`export *\` of ${file}` };
	}
	return { keys: 'all', why: `\`${name}\` sits behind more than ${FOLLOW_MAX_HOPS} re-exports` };
}

function is_reexport(s: ExportSummary): s is { follow: string[]; imported: string } {
	return typeof s === 'object' && s !== null && 'follow' in s;
}

function read_file_sync(file: string): string | null {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}
