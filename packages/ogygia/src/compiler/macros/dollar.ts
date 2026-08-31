/**
 * `import.meta.og.$()` — the boundary mark for FUNCTIONS, as a compile construct.
 *
 * A closure can't serialize; what can is a handle: WHERE the code lives + WHAT it captured.
 * The construct does the split at build time:
 *
 *   setContext('fmt', import.meta.og.$((n) => `€${(n * (1 + tax)).toFixed(2)}`));
 *     ↓
 *   setContext('fmt', __og_$('src/routes/+layout.svelte#$0', [tax],
 *     (tax) => ((n) => `€${(n * (1 + tax)).toFixed(2)}`)));
 *
 * `__og_$` (runtime, fn-transport.ts) registers the factory under the tag and returns the LIVE
 * bound function — the host renders with a real closure; if it crosses a boundary, the fn kind
 * ships `{t: tag, d: bound}` and the far side rebinds. The factory is SELF-CONTAINED by
 * construction (see capture law), so the same factory text is also collected for the
 * `virtual:ogygia/fn-manifest` module the client runtime imports — every factory registers
 * before any island hydrates, and calls stay synchronous.
 *
 * CAPTURE LAW (v1): a free identifier inside the marked function becomes a BOUND PARAMETER —
 * its VALUE crosses as data (same law as island props; the boundary classifier judges it at
 * the seam). Recognized globals (console, Math, JSON, fetch, …) pass through untouched.
 * Because every non-global free name is bound, the factory references NOTHING from its module
 * — which is what makes hoisting it into the manifest a pure text move. A capture that is a
 * module IMPORT therefore crosses by VALUE too; if that value can't serialize (a function),
 * the boundary errors at the seam with the path — move that dependency inside the marked fn
 * (import it there via a bound serializable, or use a store/wire capture for live state).
 *
 * STRICT BY CONSTRUCTION (og-wire's playbook): the construct is legal in exactly ONE shape —
 * a direct call `import.meta.og.$(<inline function expression>)`. Bare access, aliasing,
 * zero/multiple arguments, or a non-function argument are BUILD ERRORS naming file:line.
 * Detection is AST-precise over the module's JS regions; no scanner fallback — a mid-edit
 * unparseable file simply doesn't transform (the marker then fails at runtime loudly, since
 * `import.meta.og` is undefined without the transform).
 */
import { og_js_regions } from '../parse/scan.js';
import { match_close } from '../parse/scan.js';
import { parse_module } from '../parse/oxc.js';
import { og_member } from './wire.js';

const MARKER = 'import.meta.og.$';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

/** Globals a hoisted factory may reference without binding (never captured). */
const KNOWN_GLOBALS = new Set([
	'undefined',
	'null',
	'true',
	'false',
	'NaN',
	'Infinity',
	'globalThis',
	'console',
	'Math',
	'JSON',
	'Date',
	'RegExp',
	'Error',
	'TypeError',
	'RangeError',
	'Object',
	'Array',
	'String',
	'Number',
	'Boolean',
	'Symbol',
	'BigInt',
	'Map',
	'Set',
	'WeakMap',
	'WeakSet',
	'Promise',
	'Proxy',
	'Reflect',
	'ArrayBuffer',
	'Uint8Array',
	'TextEncoder',
	'TextDecoder',
	'URL',
	'URLSearchParams',
	'fetch',
	'Request',
	'Response',
	'Headers',
	'FormData',
	'AbortController',
	'structuredClone',
	'queueMicrotask',
	'setTimeout',
	'clearTimeout',
	'setInterval',
	'clearInterval',
	'crypto',
	'performance',
	'atob',
	'btoa',
	'isNaN',
	'isFinite',
	'parseInt',
	'parseFloat',
	'encodeURIComponent',
	'decodeURIComponent',
	'window',
	'document',
	'navigator',
	'location',
	'arguments'
]);

function walk(
	node: Node,
	visit: (n: Node, parent: Node | null) => void,
	parent: Node | null = null
): void {
	visit(node, parent);
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (const c of child)
				if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, visit, node);
		} else if (child && typeof child === 'object' && typeof child.type === 'string') {
			walk(child, visit, node);
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
		`[ogygia] ${id}:${line_of(src, offset)} — ${what}. import.meta.og.$ is legal in exactly one ` +
			`shape: a direct call wrapping an inline function — import.meta.og.$((args) => { … }). ` +
			`It hoists that function so its VALUE can cross an island boundary as a handle.`
	);
}

/** Names DECLARED anywhere inside `fn` (params, vars, inner fns, catch, destructuring). */
function declared_names(fn: Node): Set<string> {
	const out = new Set<string>();
	const collect_pattern = (p: Node | null | undefined): void => {
		if (!p) return;
		switch (p.type) {
			case 'Identifier':
				out.add(p.name);
				break;
			case 'ObjectPattern':
				for (const prop of p.properties ?? []) collect_pattern(prop.value ?? prop.argument);
				break;
			case 'ArrayPattern':
				for (const el of p.elements ?? []) collect_pattern(el);
				break;
			case 'AssignmentPattern':
				collect_pattern(p.left);
				break;
			case 'RestElement':
				collect_pattern(p.argument);
				break;
		}
	};
	walk(fn, (n) => {
		if (n.type === 'VariableDeclarator') collect_pattern(n.id);
		else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') {
			if (n.id?.name) out.add(n.id.name);
		} else if (n.type === 'CatchClause') collect_pattern(n.param);
		else if (
			n.type === 'FunctionExpression' ||
			n.type === 'ArrowFunctionExpression' ||
			n.type === 'FunctionDeclaration'
		) {
			for (const p of n.params ?? []) collect_pattern(p);
			if (n.id?.name) out.add(n.id.name);
		}
	});
	for (const p of fn.params ?? []) collect_pattern(p);
	return out;
}

/** Free identifiers of `fn`: referenced, not declared inside, not a known global. Source order. */
function free_names(fn: Node): string[] {
	const declared = declared_names(fn);
	const seen = new Set<string>();
	const out: string[] = [];
	walk(fn, (n, parent) => {
		if (n.type !== 'Identifier') return;
		const name = n.name as string;
		if (declared.has(name) || KNOWN_GLOBALS.has(name) || seen.has(name)) return;
		if (parent) {
			const pt = parent.type as string;
			// non-reference positions: member property (a.b), non-shorthand object key, labels,
			// import/export names, and TS type positions — a `: MyType` reference is not a value
			// capture (matters once og.$ closures carry TS annotations, in a `lang="ts"` file).
			if (pt.startsWith('TS')) return;
			if (pt === 'MemberExpression' && parent.property === n && !parent.computed) return;
			if ((pt === 'Property' || pt === 'ObjectProperty') && parent.key === n && !parent.shorthand)
				return;
			if (pt === 'LabeledStatement' || pt === 'BreakStatement' || pt === 'ContinueStatement')
				return;
		}
		seen.add(name);
		out.push(name);
	});
	return out;
}

/**
 * The moved factory text is a RAW source slice, so in a `<script lang="ts">` (or `.ts`) file it still
 * carries TS type annotations — and it lands in a PLAIN-JS registration script (`data-ogygia-fnm`) +
 * the fn-manifest module. `(n: number) => …` there is a syntax error. Blank every TS-only span inside
 * `fn` (type annotations, generics, `as`/`satisfies`/`!`) with spaces — length-preserving, so the
 * captured-name offsets and the surrounding slice stay valid. This is the same technique as
 * ts-blank-space, scoped to the one hoisted function.
 */
function strip_ts_types(fn: Node, region_code: string): string {
	const base = fn.start as number;
	const chars = region_code.slice(base, fn.end as number).split('');
	const blank = (s: number, e: number): void => {
		for (let i = s - base; i < e - base; i++) if (i >= 0 && i < chars.length) chars[i] = ' ';
	};
	walk(fn, (n) => {
		const t = n.type as string;
		// `: Type` on params / vars / arrow return, and `<T>` generics — the whole node is TS-only.
		if (
			t === 'TSTypeAnnotation' ||
			t === 'TSTypeParameterDeclaration' ||
			t === 'TSTypeParameterInstantiation'
		) {
			blank(n.start as number, n.end as number);
		} else if (
			// `expr as Type` / `expr satisfies Type` / `expr!` / `expr<T>` — keep the expression, blank
			// only the TS suffix after it.
			t === 'TSAsExpression' ||
			t === 'TSSatisfiesExpression' ||
			t === 'TSNonNullExpression' ||
			t === 'TSInstantiationExpression'
		) {
			const expr = (n as { expression?: Node }).expression;
			if (expr) blank(expr.end as number, n.end as number);
		}
	});
	return chars.join('');
}

/** One hoisted factory, destined for the fn manifest. `factory_src` is self-contained. */
export interface DollarHoist {
	tag: string;
	factory_src: string;
}

export interface DollarResult {
	code: string;
	hoists: DollarHoist[];
}

/**
 * Rewrite every `import.meta.og.$` mark in `src`. Returns the input (same reference, empty
 * hoists) when there is nothing to do. Throws build-error voice on misuse. `rel_id` is the
 * root-relative module path used for tags; `markup_exts` as in og-wire (['.svelte']).
 */
export function rewrite_dollar(
	src: string,
	id: string,
	rel_id: string,
	markup_exts: readonly string[]
): DollarResult {
	if (!src.includes(MARKER)) return { code: src, hoists: [] };
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return { code: src, hoists: [] };

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	const hoists: DollarHoist[] = [];
	let seq = 0;
	let needs_import = false;
	let needs_boundary_import = false;

	for (const region of regions) {
		// Parse as TS (a JS superset), so a `lang="ts"` script's og.$ closures — and any TS type
		// annotations inside them — parse instead of erroring in oxc's JS mode (`.svelte` → JS). The
		// template-call path below already does this; strip_ts_types then blanks the type spans from the
		// hoisted factory text (a JS-mode parse yields no TS nodes to strip, so the types would leak).
		const { program, ok } = parse_module(region.code, id.endsWith('.svelte') ? id + '.ts' : id);
		if (!ok || !program) continue; // mid-edit unparseable: no transform (marker fails loudly at runtime)

		// SERVER-ONLY imports may never be CAPTURED: on any page that serializes the handle, the
		// bound value ships into client HTML (a secret leak), and the hoisted factory can't
		// re-import them client-side anyway. Map local name → source for the rejection message.
		const server_only = new Map<string, string>();
		for (const node of (program.body ?? []) as Node[]) {
			if (node.type !== 'ImportDeclaration') continue;
			const src_val = node.source?.value as string | undefined;
			if (!src_val) continue;
			const is_server =
				src_val === '$app/server' ||
				src_val.startsWith('$env/static/private') ||
				src_val.startsWith('$env/dynamic/private') ||
				/\.server(\.|$|\/)/.test(src_val);
			if (!is_server) continue;
			for (const sp of node.specifiers ?? []) {
				if (sp.local?.name) server_only.set(sp.local.name, src_val);
			}
		}

		const claimed = new Set<Node>();
		walk(program, (n) => {
			if (n.type === 'CallExpression' && og_member(n.callee as Node) === '$') {
				const abs = region.offset + n.start;
				const args = n.arguments as Node[] | undefined;
				if (!args || args.length !== 1)
					misuse(id, src, abs, `$() takes exactly one argument — the function to hoist`);
				const fn = args[0]!;
				if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
					// THE UNIVERSAL BOUNDARY MARK: a non-function value isn't hoisted — it's ASSERTED.
					// Rewrite to a runtime classification at the marked site, so a refusal (DOM node,
					// bare fn, unwired class, secret) throws with THIS file:line at creation, and a
					// legal value passes through untouched (mark-don't-wrap; passports already ride it).
					claimed.add(n);
					claimed.add(n.callee as Node);
					const expr_text = strip_ts_types(fn, region.code);
					const site = `${rel_id}:${line_of(src, abs)}`;
					needs_boundary_import = true;
					edits.push({
						start: abs,
						end: region.offset + n.end,
						text: `__og_boundary((${expr_text}), ${JSON.stringify(site)})`
					});
					return;
				}
				claimed.add(n);
				claimed.add(n.callee as Node);
				const captures = free_names(fn);
				for (const c of captures) {
					const from = server_only.get(c);
					if (from) {
						misuse(
							id,
							src,
							abs,
							`$() captures \`${c}\` from the server-only module '${from}' — its value would ship ` +
								`into client HTML. Do the server work in a remote function and capture ITS result, ` +
								`or pass a derived, non-secret value instead`
						);
					}
				}
				const fn_text = strip_ts_types(fn, region.code);
				const tag = `${rel_id}#$${seq++}`;
				// factory: captures become params SHADOWING the outer names, so the moved text's
				// references bind to them — self-contained by construction.
				const factory = `(${captures.join(', ')}) => (${fn_text})`;
				hoists.push({ tag, factory_src: factory });
				needs_import = true;
				edits.push({
					start: abs,
					end: region.offset + n.end,
					text: `__og_$(${JSON.stringify(tag)}, [${captures.join(', ')}], ${factory})`
				});
				return;
			}
			if (og_member(n) === '$' && !claimed.has(n)) {
				misuse(id, src, region.offset + n.start, `bare import.meta.og.$ used as a value`);
			}
		});
		// inject the runtime imports at the top of the FIRST region that produced an edit.
		// SAME-LINE (no trailing newline) on purpose: every rewrite in this file is a same-line
		// splice, so keeping the import on line 1 preserves EVERY line number — breakpoints and
		// stack traces in marked files stay exact even without a composed sourcemap.
		if (
			(needs_import || needs_boundary_import) &&
			!edits.some((e) => e.text.startsWith('import'))
		) {
			const names = [needs_import ? '__og_$' : '', needs_boundary_import ? '__og_boundary' : '']
				.filter(Boolean)
				.join(', ');
			edits.push({
				start: region.offset,
				end: region.offset,
				text: `import { ${names} } from 'ogygia/internal';`
			});
			needs_import = false;
			needs_boundary_import = false;
		}
	}

	// TEMPLATE marks — `<Island fmt={import.meta.og.$(…)} />`. A markup file's expressions live
	// OUTSIDE the JS regions, so the AST pass above never sees them. Find them with the
	// string-aware lexer, skip anything inside a processed region, and parse each ARG standalone
	// as an expression: an inline function hoists exactly like a script-block mark (free names
	// resolve against the component scope by NAME, which is all capture analysis needs); anything
	// else becomes the same boundary assertion. Imports are injected into the FIRST script region.
	// The JS lexer can't scan markup (`</script>` reads as a regex opener), so template hits are
	// found by literal marker + a context guard: the marker must open a svelte EXPRESSION (the
	// previous non-space char is `{` or `(`), and its parens are matched by the quote-aware
	// match_close (the ARGS are JS, so string-awareness matters there).
	const in_region = (pos: number) =>
		regions.some((r) => pos >= r.offset && pos < r.offset + r.code.length);
	type TplCall = { start: number; end: number; args: string };
	const template_calls: TplCall[] = [];
	{
		const M = 'import.meta.og.$';
		let at = -1;
		while ((at = src.indexOf(M, at + 1)) !== -1) {
			if (in_region(at)) continue;
			const after = at + M.length;
			if (/[A-Za-z0-9_$.]/.test(src[after] ?? '')) continue; // .store / other methods
			let open = after;
			while (open < src.length && /\s/.test(src[open]!)) open++;
			if (src[open] !== '(') continue;
			let before = at - 1;
			while (before >= 0 && /\s/.test(src[before]!)) before--;
			if (src[before] !== '{' && src[before] !== '(') continue; // must open an expression
			const close = match_close(src, open);
			if (close < 0) continue;
			template_calls.push({ start: at, end: close + 1, args: src.slice(open + 1, close) });
			at = close;
		}
	}
	let template_needs: { fn: boolean; boundary: boolean } | null = null;
	for (const call of template_calls) {
		const arg_text = call.args.trim();
		if (!arg_text) misuse(id, src, call.start, `$() takes exactly one argument`);
		// Parse as TS (the wrapped expr id ends `.expr.ts`), then strip TS type spans from the moved
		// text — a markup `fmt={import.meta.og.$((n: number) => …)}` hoists into the plain-JS manifest
		// just like a script one, so its annotations must be blanked too.
		const wrapped = `(${arg_text})`;
		const { program, ok } = parse_module(wrapped, id.endsWith('.svelte') ? id + '.expr.ts' : id);
		if (!ok || !program)
			misuse(id, src, call.start, `$()'s argument does not parse as an expression`);
		const stmt = (program.body?.[0] ?? {}) as Node;
		let expr = (stmt.expression ?? {}) as Node;
		while (expr.type === 'ParenthesizedExpression') expr = expr.expression as Node;
		const expr_text = strip_ts_types(expr, wrapped);
		if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
			const captures = free_names(expr);
			const tag = `${rel_id}#$${seq++}`;
			const factory = `(${captures.join(', ')}) => (${expr_text})`;
			hoists.push({ tag, factory_src: factory });
			(template_needs ??= { fn: false, boundary: false }).fn = true;
			edits.push({
				start: call.start,
				end: call.end,
				text: `__og_$(${JSON.stringify(tag)}, [${captures.join(', ')}], ${factory})`
			});
		} else {
			const site = `${rel_id}:${line_of(src, call.start)}`;
			(template_needs ??= { fn: false, boundary: false }).boundary = true;
			edits.push({
				start: call.start,
				end: call.end,
				text: `__og_boundary((${expr_text}), ${JSON.stringify(site)})`
			});
		}
	}
	if (template_needs) {
		const first = regions[0];
		if (!first)
			misuse(id, src, 0, `og.$ in markup needs a <script> block to receive its runtime import`);
		const names = [
			template_needs.fn ? '__og_$' : '',
			template_needs.boundary ? '__og_boundary' : ''
		]
			.filter(Boolean)
			.join(', ');
		// merge with a script-pass injection if one already exists; else inject same-line
		const existing = edits.find((e) => e.start === first.offset && e.text.startsWith('import { '));
		if (existing) {
			const have = existing.text.slice('import { '.length, existing.text.indexOf(' }'));
			const merged = [...new Set([...have.split(', '), ...names.split(', ')])]
				.filter(Boolean)
				.join(', ');
			existing.text = `import { ${merged} } from 'ogygia/internal';`;
		} else {
			edits.push({
				start: first.offset,
				end: first.offset,
				text: `import { ${names} } from 'ogygia/internal';`
			});
		}
	}

	if (!edits.length) return { code: src, hoists: [] };
	edits.sort((a, b) => a.start - b.start);
	let out = '';
	let last = 0;
	for (const e of edits) {
		out += src.slice(last, e.start) + e.text;
		last = e.end;
	}
	out += src.slice(last);
	return { code: out, hoists };
}
