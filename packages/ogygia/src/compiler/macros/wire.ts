/**
 * `import.meta.og.wire()` — the transportable mark, as a compile construct. A class opts into
 * crossing island boundaries by declaring how it travels:
 *
 *   export class Cart {
 *     items = $state<Item[]>([]);
 *     static wire = import.meta.og.wire({
 *       encode: (c) => ({ items: $state.snapshot(c.items) }),
 *       decode: (d) => new Cart(d.items)
 *     });
 *   }
 *
 * The macro CONSUMES the member and MINTS the key: the compiled output is
 * `static [Symbol.for('ogygia.wire')] = <codec>` — a symbol-keyed protocol member the runtime
 * looks codecs up by. The symbol never exists in source, so there is nothing to import, alias,
 * or leak. (A literal `static [import.meta.og.wire]` KEY is grammatically impossible in
 * TypeScript — TS1166: a computed class key must be a plain dotted name, and `import.meta` is
 * meta-syntax. The call form is the strict, typechecked equivalent.)
 *
 * STRICT BY CONSTRUCTION — the construct is legal in exactly ONE position:
 *   • a static member named exactly `wire`, initialized with the call, inside a class body;
 *   • with exactly one argument, the codec (`{ encode, decode, id?, merge? }`).
 * Anything else — another member name, a variable, an argument, a bare `import.meta.og.wire`
 * access, an arg-less call — is a BUILD ERROR naming the file and line. And if the transform
 * somehow never runs, `import.meta.og` is undefined at runtime, so it fails on load rather than
 * half-working.
 *
 * Detection is AST-precise over the module's JS regions (whole file for `.ts`/`.js`, each
 * `<script>` block for `.svelte`), with a string scanner as the fallback for source that doesn't
 * parse mid-edit — so the marker in a comment or string is never rewritten.
 */
import { og_js_regions, type JsRegion } from '../parse/scan.js';
import { find_og_calls } from '../parse/scan.js';
import { parse_module } from '../parse/oxc.js';

/** The key expression a wire member rewrites to — the same symbol the runtime registry uses. */
export const WIRE_EXPR = "Symbol.for('ogygia.wire')";
const MARKER = 'import.meta.og.wire';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

/** If `node` is the member expression `import.meta.og.<name>`, return `<name>`; else null. */
export function og_member(node: Node | undefined): string | null {
	if (!node || node.type !== 'MemberExpression' || node.computed) return null;
	const name = node.property?.name;
	if (typeof name !== 'string') return null;
	const og = node.object;
	if (og?.type !== 'MemberExpression' || og.computed || og.property?.name !== 'og') return null;
	const meta = og.object;
	if (meta?.type !== 'MetaProperty' || meta.meta?.name !== 'import' || meta.property?.name !== 'meta') return null;
	return name;
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

/** One wire mark: the span to replace and its replacement text. */
type Edit = { start: number; end: number; text: string };

/** 1-based line of an absolute offset in `src` — for build-error voice. */
function line_of(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
	return line;
}

/** The strict-position build error. `id` + line point at the offending spelling. */
function misuse(id: string, src: string, offset: number, what: string): never {
	throw new Error(
		`[ogygia] ${id}:${line_of(src, offset)} — ${what}. import.meta.og.wire is legal in exactly one ` +
			`position: \`static wire = import.meta.og.wire({ encode, decode })\` inside a class body. ` +
			`The macro consumes that member and mints the symbol key; the construct is not a value.`
	);
}

/**
 * AST pass over one JS region. The ONLY legal shape rewrites; every other appearance of the
 * construct throws the strict-position error. Returns null when the region doesn't parse
 * (caller falls back to the scanner).
 */
function ast_edits(src: string, region: JsRegion, id: string): Edit[] | null {
	const { program, ok } = parse_module(region.code, id);
	if (!ok || !program) return null;
	const edits: Edit[] = [];
	// Nodes accounted for by a legal member: the call and its callee chain (so the strictness
	// sweep below doesn't re-flag the pieces of a legal declaration).
	const claimed = new Set<Node>();
	walk(program, (n) => {
		if ((n.type === 'PropertyDefinition' || n.type === 'ClassProperty') && n.static === true) {
			const v = n.value as Node | undefined;
			if (v?.type === 'CallExpression' && og_member(v.callee as Node) === 'wire') {
				const abs = region.offset + n.start;
				// Name lock: the member must be literally `wire` (non-computed).
				const key = n.key as Node | undefined;
				const name = !n.computed && key?.type === 'Identifier' ? key.name : null;
				if (name !== 'wire') misuse(id, src, abs, `the wire member must be named exactly \`wire\` (got \`${name ?? '<computed>'}\`)`);
				const args = v.arguments as Node[] | undefined;
				if (!args || args.length !== 1) {
					misuse(id, src, abs, `wire() takes exactly one argument — the codec ({ encode, decode })`);
				}
				claimed.add(v);
				claimed.add(v.callee as Node);
				const a = args[0]!;
				// TWO disjoint edits, leaving the codec verbatim IN PLACE — so a nested construct
				// inside the codec (e.g. an inner class with its own wire) gets its own edits and
				// never overlaps. Edit 1: `static wire = import.meta.og.wire(` → `static [SYM] = `.
				// Edit 2: the closing `)` (+ any trailing comma) → ``.
				edits.push({ start: abs, end: region.offset + a.start, text: `static [${WIRE_EXPR}] = ` });
				edits.push({ start: region.offset + a.end, end: region.offset + v.end, text: '' });
			}
			return;
		}
		// Strictness sweep: any OTHER appearance of the construct is a build error.
		if (n.type === 'CallExpression' && og_member(n.callee as Node) === 'wire' && !claimed.has(n)) {
			misuse(id, src, region.offset + n.start, `wire() called outside a static class member`);
		}
		if (og_member(n) === 'wire' && !claimed.has(n)) {
			misuse(id, src, region.offset + n.start, `bare import.meta.og.wire used as a value`);
		}
	});
	edits.sort((a, b) => a.start - b.start);
	return edits;
}

/** Scanner fallback for source that doesn't parse mid-edit: rewrite only the exact legal spelling
 *  (`static wire = import.meta.og.wire(…)`). Uses the STRING-AWARE {@link find_og_calls} to locate
 *  the wire CALL — so a marker inside a string/comment/regex is never a hit (a naive regex here once
 *  corrupted `"static wire = import.meta.og.wire({})"` inside a string) — then confirms the call is
 *  the initializer of a `static wire =` member by inspecting the immediately-preceding tokens. Misuse
 *  isn't judged here — the next parseable state goes through the AST pass, which enforces strictness. */
function scan_edits(src: string, region: JsRegion): Edit[] {
	const edits: Edit[] = [];
	const code = region.code;
	for (const call of find_og_calls(code, 'import.meta.og.')) {
		if (call.method !== 'wire') continue;
		// `call.start` is at the `import.meta.og.wire` marker; the member must be `static wire =` just
		// before it (whitespace allowed). This anchored test can't match across a string/comment on its
		// own, and the call itself was already proven to be in code context by find_og_calls.
		const before = code.slice(0, call.start);
		const m = /\bstatic\s+wire\s*=\s*$/.exec(before);
		if (!m) continue;
		const inner = call.args.trim();
		if (!inner) continue;
		edits.push({
			start: region.offset + m.index,
			end: region.offset + call.end,
			text: `static [${WIRE_EXPR}] = ${inner}`
		});
	}
	return edits;
}

/**
 * Rewrite every wire mark in `src`, enforcing the strict position rules. Extension-aware:
 * whole-file for JS/TS, `<script>` blocks for `.svelte`. Returns the input unchanged (same
 * reference) when there is nothing to do. Throws (build-error voice, file:line) on any misuse.
 * `markup_exts` is the resolved construct-host set (the plugin passes `['.svelte']`).
 */
export function rewrite_wire(src: string, id: string, markup_exts: readonly string[]): string {
	if (!src.includes(MARKER)) return src;
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return src;

	const edits: Edit[] = [];
	for (const region of regions) edits.push(...(ast_edits(src, region, id) ?? scan_edits(src, region)));
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
