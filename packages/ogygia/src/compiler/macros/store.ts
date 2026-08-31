/**
 * `import.meta.og.store()` — the store-factory assert mark, as a compile construct.
 *
 * The store kind's registered-factory tier needs a build tag ↔ factory pairing so decode can
 * rebuild a store THROUGH its factory (custom methods survive the wire). Provable factories
 * can be auto-branded later; this construct is the floor that always works — the author
 * asserts "this returns a store", and the compiler does the mechanical part:
 *
 *   export const createCart = import.meta.og.store((seed = []) => { … });
 *     ↓
 *   export const createCart = __og_store('src/lib/cart.ts#store0', (seed = []) => { … });
 *
 * `__og_store` (store-transport.ts) registers the factory at module load (the island importing
 * the factory module IS what fills decode's registry) and brands every product with the tag.
 * The factory's FIRST PARAMETER is the seed: decode calls `factory(currentValue)`.
 *
 * STRICT BY CONSTRUCTION (og-wire's playbook): legal in exactly ONE shape — a direct call
 * `import.meta.og.store(<inline function or identifier>)`. Bare access, aliasing, zero/multiple
 * arguments, or a non-function argument are BUILD ERRORS naming file:line. AST-precise over
 * the module's JS regions; a mid-edit unparseable file doesn't transform (the marker then
 * fails loudly at runtime — `import.meta.og` is undefined without the transform).
 */
import { og_js_regions } from '../parse/scan.js';
import { parse_module } from '../parse/oxc.js';
import { og_member } from './wire.js';

const MARKER = 'import.meta.og.store';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

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

function misuse(id: string, src: string, offset: number, what: string): never {
	throw new Error(
		`[ogygia] ${id}:${line_of(src, offset)} — ${what}. import.meta.og.store is legal in exactly ` +
			`one shape: a direct call wrapping a store factory — ` +
			`import.meta.og.store((seed) => ({ subscribe, … })). It registers the factory under a build ` +
			`tag so islands rebuild the store THROUGH it (custom methods survive); the factory's first ` +
			`parameter is the seed value.`
	);
}

/** Unwrap oxc's preserved parens. */
function unparen(v: Node | null | undefined): Node | null | undefined {
	while (v && v.type === 'ParenthesizedExpression') v = v.expression as Node;
	return v;
}

/** Provably NOT a store — the literal tier only: bare return, undefined, void, null, primitive
 *  literals. Identifiers, calls, members, ternaries are never flagged: they could be stores, the
 *  mark is the author's assertion, and dynamic values get the runtime floor instead. */
function literal_non_store(v: Node | null | undefined): boolean {
	v = unparen(v);
	if (!v) return true;
	if (v.type === 'Identifier') return v.name === 'undefined';
	if (v.type === 'UnaryExpression') return v.operator === 'void';
	return (
		v.type === 'NullLiteral' ||
		v.type === 'BooleanLiteral' ||
		v.type === 'NumericLiteral' ||
		v.type === 'StringLiteral' ||
		v.type === 'BigIntLiteral' ||
		v.type === 'TemplateLiteral'
	);
}

/** First provably-non-store return inside an EXPLICITLY marked inline factory (top-level returns
 *  only — nested functions' returns are theirs). Region-relative offset, or undefined. */
function first_non_store_return(fn: Node): number | undefined {
	const body = fn.body as Node;
	if (body.type !== 'BlockStatement')
		return literal_non_store(body) ? (body.start as number) : undefined;
	let found: number | undefined;
	(function collect(n: Node): void {
		for (const key in n) {
			if (found !== undefined) return;
			if (key === 'type' || key === 'start' || key === 'end') continue;
			const child = n[key];
			const kids = Array.isArray(child)
				? child
				: child && typeof child === 'object' && typeof child.type === 'string'
					? [child]
					: [];
			for (const c of kids as Node[]) {
				if (
					c.type === 'ArrowFunctionExpression' ||
					c.type === 'FunctionExpression' ||
					c.type === 'FunctionDeclaration'
				)
					continue;
				if (c.type === 'ReturnStatement' && literal_non_store(c.argument as Node)) {
					found = c.start;
					return;
				}
				collect(c);
			}
		}
	})(body);
	return found;
}

/** Rewrite every `import.meta.og.store` mark. Same-reference return when nothing to do. */
export function rewrite_store(
	src: string,
	id: string,
	rel_id: string,
	markup_exts: readonly string[]
): string {
	if (!src.includes(MARKER)) return src;
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return src;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	let seq = 0;
	let needs_import = false;

	for (const region of regions) {
		const { program, ok } = parse_module(region.code, id);
		if (!ok || !program) continue;
		const claimed = new Set<Node>();
		walk(program, (n) => {
			if (n.type === 'CallExpression' && og_member(n.callee as Node) === 'store') {
				const abs = region.offset + n.start;
				const args = n.arguments as Node[] | undefined;
				if (!args || args.length !== 1)
					misuse(id, src, abs, `store() takes exactly one argument — the factory`);
				const fn = args[0]!;
				if (
					fn.type !== 'ArrowFunctionExpression' &&
					fn.type !== 'FunctionExpression' &&
					fn.type !== 'Identifier'
				) {
					misuse(
						id,
						src,
						abs,
						`store()'s argument must be a function expression or an identifier (got ${fn.type})`
					);
				}
				claimed.add(n);
				claimed.add(n.callee as Node);
				if (fn.type !== 'Identifier') {
					// WARN tier (not a build error): a literal `return undefined`/`return;`/primitive inside
					// the marked factory breaks the mark's own assertion. Legal on purpose — a client-only
					// store may return nothing on the server — so the runtime floor handles it; this names
					// the exact line at build time instead of a warning at first render.
					const bad = first_non_store_return(fn);
					if (bad !== undefined && typeof console !== 'undefined') {
						console.warn(
							`[ogygia] ${id}:${line_of(src, region.offset + bad)} — this import.meta.og.store ` +
								`factory has a return that is provably not a store (undefined/null/primitive). ` +
								`Where that branch runs, the product crosses as plain data, unbranded. If it is an ` +
								`environment guard, return a store there too (e.g. writable(seed)) and guard the ` +
								`side effects inside the factory instead.`
						);
					}
				}
				const fn_text = region.code.slice(fn.start, fn.end);
				const tag = `${rel_id}#store${seq++}`;
				needs_import = true;
				edits.push({
					start: abs,
					end: region.offset + n.end,
					text: `__og_store(${JSON.stringify(tag)}, ${fn_text})`
				});
				return;
			}
			if (og_member(n) === 'store' && !claimed.has(n)) {
				misuse(id, src, region.offset + n.start, `bare import.meta.og.store used as a value`);
			}
		});
		if (needs_import && !edits.some((e) => e.text.startsWith('import'))) {
			edits.push({
				start: region.offset,
				end: region.offset,
				text: `import { __og_store } from 'ogygia/internal';`
			});
			needs_import = false;
		}
	}

	if (!edits.length) return src;
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

/**
 * AUTO-DETECT tier: brand exported factories whose body PROVABLY returns a store, with zero
 * authoring. v1 scope (deliberately narrow — no guessing, under-branding is always safe since
 * the generic writable tier still carries the value):
 *
 *   export const createX = (seed) => ({ subscribe, … })          // object literal w/ subscribe
 *   export const createY = (seed) => writable(seed)              // direct writable()/readable()
 *   export const createZ = (seed) => { … return { subscribe } }  // every return provable
 *
 * Skipped (→ generic tier / the og.store assert): function declarations, re-exports, factories
 * returning call results (`return make(x)`), mixed/ambiguous returns, non-exported consts.
 * Requires the module to import from 'svelte/store' when the proof is a writable()/readable()
 * call (a local function named `writable` must not count).
 */
export function auto_brand_stores(
	src: string,
	id: string,
	rel_id: string,
	markup_exts: readonly string[]
): string {
	if (!src.includes('subscribe') && !src.includes('writable') && !src.includes('readable'))
		return src;
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return src;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	let seq = 0;
	let needs_import = false;

	const has_subscribe_prop = (obj: Node): boolean =>
		(obj.properties ?? []).some((p: Node) => {
			if (p.type !== 'Property' && p.type !== 'ObjectProperty') return false;
			const k = p.key as Node | undefined;
			return (
				(!p.computed && k?.type === 'Identifier' && k.name === 'subscribe') ||
				(k?.type === 'StringLiteral' && k.value === 'subscribe') ||
				(p.shorthand === true && k?.type === 'Identifier' && k.name === 'subscribe')
			);
		});

	for (const region of regions) {
		const { program, ok } = parse_module(region.code, id);
		if (!ok || !program) continue;

		// store-factory proof needs writable/readable to really be svelte/store's
		const store_fns = new Set<string>();
		for (const node of (program.body ?? []) as Node[]) {
			if (node.type !== 'ImportDeclaration' || node.source?.value !== 'svelte/store') continue;
			for (const sp of node.specifiers ?? []) {
				if (
					sp.type === 'ImportSpecifier' &&
					(sp.imported?.name === 'writable' || sp.imported?.name === 'readable')
				) {
					store_fns.add(sp.local?.name ?? sp.imported.name);
				}
			}
		}

		const provable_value = (v: Node | null | undefined): boolean => {
			// oxc preserves parens: `(i) => ({ … })` bodies arrive as ParenthesizedExpression
			while (v && v.type === 'ParenthesizedExpression') v = v.expression as Node;
			if (!v) return false;
			if (v.type === 'ObjectExpression') return has_subscribe_prop(v);
			if (v.type === 'CallExpression' && v.callee?.type === 'Identifier')
				return store_fns.has(v.callee.name);
			return false;
		};

		const provable_factory = (fn: Node): boolean => {
			if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return false;
			const body = fn.body as Node;
			if (body.type !== 'BlockStatement') return provable_value(body); // expression body
			// block body: at least one return, and EVERY top-level-reachable return is provable.
			// (nested functions' returns must not count — collect returns skipping inner fns)
			const returns: Node[] = [];
			(function collect(n: Node): void {
				for (const key in n) {
					if (key === 'type' || key === 'start' || key === 'end') continue;
					const child = n[key];
					const kids = Array.isArray(child)
						? child
						: child && typeof child === 'object' && typeof child.type === 'string'
							? [child]
							: [];
					for (const c of kids as Node[]) {
						if (
							c.type === 'ArrowFunctionExpression' ||
							c.type === 'FunctionExpression' ||
							c.type === 'FunctionDeclaration'
						)
							continue;
						if (c.type === 'ReturnStatement') returns.push(c);
						collect(c);
					}
				}
			})(body);
			return returns.length > 0 && returns.every((r) => provable_value(r.argument as Node));
		};

		for (const node of (program.body ?? []) as Node[]) {
			if (node.type !== 'ExportNamedDeclaration') continue;
			const decl = node.declaration as Node | undefined;
			if (decl?.type !== 'VariableDeclaration') continue;
			for (const d of (decl.declarations ?? []) as Node[]) {
				const init = d.init as Node | undefined;
				if (!init || !provable_factory(init)) continue;
				const name = d.id?.type === 'Identifier' ? d.id.name : `auto`;
				const tag = `${rel_id}#auto:${name}${seq ? seq : ''}`;
				seq++;
				needs_import = true;
				edits.push({
					start: region.offset + init.start,
					end: region.offset + init.start,
					text: `__og_store(${JSON.stringify(tag)}, `
				});
				edits.push({ start: region.offset + init.end, end: region.offset + init.end, text: `)` });
			}
		}
		if (needs_import && !edits.some((e) => e.text.startsWith('import'))) {
			edits.push({
				start: region.offset,
				end: region.offset,
				text: `import { __og_store } from 'ogygia/internal';`
			});
			needs_import = false;
		}
	}

	if (!edits.length) return src;
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
