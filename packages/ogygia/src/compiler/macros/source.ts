/**
 * `import.meta.og.source(fn)` — declared data sources, as a compile construct (the freeze
 * reverse index; internal/notes/freeze.md §L2):
 *
 *   export const loadBuilderContent = import.meta.og.source(async (event, category) => { … });
 *
 * The macro stamps the id from THIS definition's `file#export` (root-relative; the ogygia.files
 * identity rail applies to package paths upstream) and rewrites to
 * `__og_source('<id>', fn, opts?)` with the runtime-wrapper import injected. Loads stay
 * untouched plain TS forever; `freeze.invalidate(loadBuilderContent, [args])` reads the stamp
 * off the function — no strings anywhere.
 *
 * STRICT BY CONSTRUCTION — legal in exactly ONE position:
 *   • a top-level `export const <name> = import.meta.og.source(fn)` (or `(fn, { key })`);
 *   • 1 or 2 arguments; the first is the function.
 * Anything else — un-exported, nested, bare access, argument-less — is a BUILD ERROR naming the
 * file and line (the wire/asRegion macro laws).
 */
import { og_js_regions, find_og_calls, type JsRegion } from '../parse/scan.js';
import { parse_module } from '../parse/oxc.js';
import { og_member } from './wire.js';

// ── regexes
const EXPORT_CONST_TAIL_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

const MARKER = 'import.meta.og.source';
const IMPORT_LINE = `import { __og_source } from 'ogygia/freeze/source';\n`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

type Edit = { start: number; end: number; text: string };

function line_of(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
	return line;
}

function misuse(id: string, src: string, offset: number, what: string): never {
	throw new Error(
		`[ogygia] ${id}:${line_of(src, offset)} — ${what}. import.meta.og.source is legal in exactly ` +
			`one position: \`export const <name> = import.meta.og.source(fn)\` (optionally \`(fn, { key })\`) ` +
			`at module top level. The compiler stamps the source id from that export's identity.`
	);
}

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

/** AST pass over one JS region; null when it doesn't parse (caller uses the scanner fallback). */
function ast_edits(src: string, region: JsRegion, id: string, rel: string): Edit[] | null {
	const { program, ok } = parse_module(region.code, id);
	if (!ok || !program) return null;
	const edits: Edit[] = [];
	const claimed = new Set<Node>();

	// Legal shape: ExportNamedDeclaration > VariableDeclaration(const) > declarator with the call.
	for (const stmt of (program.body ?? []) as Node[]) {
		if (stmt.type !== 'ExportNamedDeclaration') continue;
		const decl = stmt.declaration as Node | undefined;
		if (!decl || decl.type !== 'VariableDeclaration') continue;
		for (const d of (decl.declarations ?? []) as Node[]) {
			const init = d.init as Node | undefined;
			if (init?.type !== 'CallExpression' || og_member(init.callee as Node) !== 'source') continue;
			const abs = region.offset + init.start;
			if (decl.kind !== 'const') {
				misuse(id, src, abs, `a source must be \`export const\` (got \`${decl.kind}\`)`);
			}
			const name = d.id?.type === 'Identifier' ? (d.id.name as string) : null;
			if (!name) {
				misuse(id, src, abs, `a source export must be a plain identifier (no destructuring)`);
			}
			const args = (init.arguments ?? []) as Node[];
			if (args.length < 1 || args.length > 2) {
				misuse(
					id,
					src,
					abs,
					`source() takes the function (+ optional { key }) — got ${args.length} args`
				);
			}
			claimed.add(init);
			claimed.add(init.callee as Node);
			// Rewrite the CALLEE only, keeping every argument verbatim in place, and splice the
			// stamped id in as the new first argument.
			const callee = init.callee as Node;
			edits.push({
				start: region.offset + callee.start,
				end: region.offset + callee.end,
				text: `__og_source`
			});
			edits.push({
				start: region.offset + args[0]!.start,
				end: region.offset + args[0]!.start,
				text: `${JSON.stringify(`${rel}#${name}`)}, `
			});
		}
	}

	// Strictness sweep: any unclaimed appearance is a build error.
	walk(program, (n) => {
		if (
			n.type === 'CallExpression' &&
			og_member(n.callee as Node) === 'source' &&
			!claimed.has(n)
		) {
			misuse(id, src, region.offset + n.start, `source() outside an \`export const\` initializer`);
		}
		if (og_member(n) === 'source' && !claimed.has(n)) {
			misuse(id, src, region.offset + n.start, `bare import.meta.og.source used as a value`);
		}
	});
	edits.sort((a, b) => a.start - b.start);
	return edits;
}

/** Scanner fallback for mid-edit source: rewrite only the exact legal spelling; strictness is
 *  enforced by the next parseable state's AST pass. */
function scan_edits(src: string, region: JsRegion, rel: string): Edit[] {
	const edits: Edit[] = [];
	const code = region.code;
	for (const call of find_og_calls(code, 'import.meta.og.')) {
		if (call.method !== 'source') continue;
		const before = code.slice(0, call.start);
		const m = EXPORT_CONST_TAIL_RE.exec(before);
		if (!m) continue;
		const inner = call.args.trim();
		if (!inner) continue;
		edits.push({
			start: region.offset + call.start,
			end: region.offset + call.end,
			text: `__og_source(${JSON.stringify(`${rel}#${m[1]}`)}, ${inner})`
		});
	}
	return edits;
}

/**
 * Rewrite every source mark in `src` (strict position rules), injecting the runtime-wrapper
 * import once. `rel` is the module's root-relative posix path (the id rail). Returns the input
 * unchanged (same reference) when there is nothing to do.
 */
export function rewrite_source(
	src: string,
	id: string,
	rel: string,
	markup_exts: readonly string[]
): string {
	if (!src.includes(MARKER)) return src;
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return src;

	const edits: Edit[] = [];
	for (const region of regions)
		edits.push(...(ast_edits(src, region, id, rel) ?? scan_edits(src, region, rel)));
	if (!edits.length) return src;

	edits.sort((a, b) => a.start - b.start);
	let out = '';
	let last = 0;
	for (const e of edits) {
		out += src.slice(last, e.start) + e.text;
		last = e.end;
	}
	out += src.slice(last);
	return IMPORT_LINE + out;
}
