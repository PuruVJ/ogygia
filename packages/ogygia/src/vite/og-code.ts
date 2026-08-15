/**
 * `import.meta.og.code(source, lang, meta?)` — a highlighted code SNIPPET, rendered at BUILD through
 * the app's own Shiki fence pipeline and inlined as a static region:
 *
 *   const example = import.meta.og.code(`
 *     const cart = new Cart();
 *     cart.add(item);
 *   `, 'ts', 'twoslash {2}');
 *   // …then:  <Region of={example} />
 *
 * The macro dedents the source (the indentation is an artifact of where the call sits), renders it
 * with the same themes/transformers/meta parsers a markdown fence uses (so `meta` behaves exactly
 * like a fence infostring), and rewrites the call to `og_html_region("<baked html>")` — a pure-HTML
 * region, no client JS. Content-addressed via the fence cache, so a snippet renders once per build.
 *
 * The `source` must be a STATIC string or template literal — a `${…}` interpolation is a build error
 * (the build can't resolve a runtime value). `lang` and `meta` must be string literals. Detection is
 * AST-precise over the module's JS regions (whole file for `.ts`/`.js`, `<script>` blocks for
 * `.svelte`), with the marker in a comment or string never mistaken for a call.
 */
import { og_js_regions, is_js_module, type JsRegion } from './og-extract.js';
import { og_member } from './og-wire.js';
import { dedent } from './dedent.js';
import { parse_module } from './og-parse.js';

// Both snippet constructs share this transform: `code(source, lang, meta?)` and `md(text)` each bake
// to static html at build and inline as the same `og_html_region(...)`.
const MARKERS = ['import.meta.og.code', 'import.meta.og.md'] as const;
const HELPER = '__og_html_region';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = Record<string, any>;

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

/** 1-based line of an absolute offset. */
function line_of(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
	return line;
}

/** A located snippet call: the span to replace, plus its resolved static arguments. `code` carries
 *  `lang`/`meta`; `md` carries only `source` (the markdown text). */
export type CodeCall = { kind: 'code' | 'md'; start: number; end: number; source: string; lang: string; meta: string };

/** Read a STATIC string from an arg node: a string literal, or a no-interpolation template literal.
 *  Throws (build voice) on anything else. `label` names the arg for the error. */
function static_string(node: Node | undefined, src: string, id: string, offset: number, label: string): string {
	if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node?.type === 'TemplateLiteral') {
		if ((node.expressions?.length ?? 0) > 0) {
			throw new Error(
				`[ogygia] ${id}:${line_of(src, offset)} — import.meta.og.code(): ${label} is a template literal with \${…} interpolation, which the build can't resolve. Use a static string.`
			);
		}
		return String(node.quasis?.[0]?.value?.cooked ?? '');
	}
	throw new Error(
		`[ogygia] ${id}:${line_of(src, offset)} — import.meta.og.code(): ${label} must be a static string literal.`
	);
}

/** Find every legal `import.meta.og.code(...)` / `.md(...)` call in one JS region. Returns null when
 *  the region doesn't parse (caller skips it — no scanner fallback; a half-typed file just waits). */
function find_calls(src: string, region: JsRegion, id: string): CodeCall[] | null {
	const { program, ok } = parse_module(region.code, id);
	if (!ok || !program) return null;
	const calls: CodeCall[] = [];
	walk(program, (n) => {
		if (n.type !== 'CallExpression') return;
		const method = og_member(n.callee as Node);
		if (method !== 'code' && method !== 'md') return;
		const abs = region.offset + n.start;
		const args = (n.arguments as Node[] | undefined) ?? [];
		if (method === 'md') {
			if (args.length !== 1) {
				throw new Error(`[ogygia] ${id}:${line_of(src, abs)} — import.meta.og.md(text) takes exactly one argument.`);
			}
			const source = dedent(static_string(args[0], src, id, abs, 'text'));
			calls.push({ kind: 'md', start: abs, end: region.offset + n.end, source, lang: '', meta: '' });
			return;
		}
		if (args.length < 2 || args.length > 3) {
			throw new Error(
				`[ogygia] ${id}:${line_of(src, abs)} — import.meta.og.code(source, lang, meta?) takes 2 or 3 arguments.`
			);
		}
		const source = dedent(static_string(args[0], src, id, abs, 'source'));
		const lang = static_string(args[1], src, id, abs, 'lang');
		const meta = args[2] ? static_string(args[2], src, id, abs, 'meta') : '';
		calls.push({ kind: 'code', start: abs, end: region.offset + n.end, source, lang, meta });
	});
	return calls;
}

/** Where to inject the helper import: the top of the first JS region (a `.svelte` script block's
 *  first byte, or byte 0 of a `.ts` module). */
function import_anchor(regions: JsRegion[]): number {
	return regions.length ? regions[0]!.offset : 0;
}

/**
 * Rewrite every `import.meta.og.code(...)` in `src` to an inlined `og_html_region("…")`. ASYNC:
 * `render` bakes each snippet (Shiki) and returns its html. Extension-aware. Returns the input
 * unchanged (same reference) when there is nothing to do.
 */
export async function rewrite_code(
	src: string,
	id: string,
	markup_exts: readonly string[],
	render: (call: CodeCall) => Promise<string>
): Promise<string> {
	if (!MARKERS.some((m) => src.includes(m))) return src;
	const regions = og_js_regions(src, id, markup_exts);
	if (!regions) return src;

	const calls: CodeCall[] = [];
	for (const region of regions) {
		const found = find_calls(src, region, id);
		if (found) calls.push(...found);
	}
	if (!calls.length) return src;

	// Bake all snippets (cache makes repeats cheap), then splice by ascending offset.
	const htmls = await Promise.all(calls.map((c) => render(c)));

	const anchor = import_anchor(regions);
	const import_stmt = `import { og_html_region as ${HELPER} } from 'ogygia';\n`;
	let out = '';
	let last = 0;
	// The import goes at the anchor; a call may sit before or after it, so weave both in offset order.
	const edits = calls
		.map((c, i) => ({ start: c.start, end: c.end, text: `${HELPER}(${JSON.stringify(htmls[i])})` }))
		.concat([{ start: anchor, end: anchor, text: import_stmt }])
		.sort((a, b) => a.start - b.start || a.end - b.end);
	for (const e of edits) {
		out += src.slice(last, e.start) + e.text;
		last = e.end;
	}
	out += src.slice(last);
	// A `.ts` module and a `.svelte` script block both accept a top-of-scope import at the anchor.
	void is_js_module;
	return out;
}
