/**
 * `virtual:ogygia/registry-stub/…` — keep a REGION REGISTRY out of a csr=false page's client graph.
 *
 * THE LEAK: a `.ts` registry (`import Card from './Card.svelte' with { wake: 'visible' }` × N, the
 * Builder / CMS block-factory shape) is a plain module to Kit. A csr=false route host that imports
 * it pulls every marked component's WRAPPER — and through it the real component, its scoped CSS and
 * its chunk closure — into that page node's client graph. Kit then links `node.stylesheets` for the
 * whole registry on every page the host serves: one large landing page linked 163 stylesheets
 * (337 registry marks) for 21 rendered islands, all render-blocking. The client never runs any of it
 * — a csr=false document ships no Kit client at all; the node's JS exists only so Kit can link CSS.
 *
 * THE RULE: what a page needs is decided at SSR, by the render pass — Region.svelte links the CSS of
 * every region that actually renders (`island_css_html` / `region_css_html`, claimed per request) and
 * preloads its chunk. So on the csr=false CLIENT leg of a BUILD a route host's import of a registry
 * resolves to this stub: a module exporting the same NAMES (as `undefined`) so the bundle links, and
 * nothing else. The registry module itself is untouched — a csr=true page (Kit hydrates it, so it
 * needs the real wrappers) and the island world keep importing the real thing. Dev keeps the graph
 * (Vite serves CSS as modules there; a stub would unstyle the page).
 *
 * PLAIN IMPORTS STAY. A registry also holds PLAIN imports (a heading, a banner wrapper: no `with`).
 * Those render on the server and never pass through Region, so the page node's client graph is the
 * only thing that links their CSS — a names-only stub left them unstyled on every deploy (dev keeps
 * the graph, so it never showed there). The client-leg registry is therefore the registry ITSELF
 * with only its marks blanked ({@link registry_client_source}): every plain import, re-export,
 * barrel and style import keeps its edge, resolved from the registry's own directory (the module id
 * is the real path plus {@link REGISTRY_CLIENT_QUERY}), so Kit links their CSS exactly as before the
 * stub. Their CSS is linked whether they render or not — the price of the graph deciding; marked
 * imports stay out, which is the leak this module exists for.
 */
import { walk } from 'estree-walker';
import { parse_module } from '../parse/oxc.js';

export const REGISTRY_STUB_PREFIX = 'virtual:ogygia/registry-stub/';

/** The query that names a registry's client-leg variant (its marks blanked, everything else kept). */
export const REGISTRY_CLIENT_QUERY = '?og-registry-client';

/** The client-leg variant id of a registry: its real absolute path (relative imports resolve from
 *  the registry's own directory) plus {@link REGISTRY_CLIENT_QUERY}. */
export function registry_client_id(abs_path: string): string {
	return abs_path + REGISTRY_CLIENT_QUERY;
}

/** The registry path a client-leg variant id names, or `null` for any other id. */
export function registry_client_path(id: string): string | null {
	return id.endsWith(REGISTRY_CLIENT_QUERY) ? id.slice(0, -REGISTRY_CLIENT_QUERY.length) : null;
}

type EsNode = {
	type: string;
	start: number;
	end: number;
	[key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** True when `node` is `import.meta.og.<prop>`. */
function is_og_macro(node: EsNode | undefined, prop: string): boolean {
	return (
		node?.type === 'MemberExpression' &&
		node.property?.name === prop &&
		node.object?.type === 'MemberExpression' &&
		node.object.property?.name === 'og' &&
		node.object.object?.type === 'MetaProperty' &&
		node.object.object.meta?.name === 'import' &&
		node.object.object.property?.name === 'meta'
	);
}

/**
 * The static VALUE import specifiers of a script module — `import … from`, side-effect `import '…'`,
 * `export … from`, `export * from` (type-only forms skipped; dynamic `import()` skipped: Kit links
 * no CSS for a node's dynamic chunks). `null` when the module does not parse.
 */
export function static_script_specs(source: string, file: string): string[] | null {
	const parsed = parse_module(source, file);
	if (!parsed.ok || !parsed.program) return null;
	const specs: string[] = [];
	for (const node of (parsed.program as EsNode).body as EsNode[]) {
		const is_from =
			node.type === 'ImportDeclaration' ||
			node.type === 'ExportAllDeclaration' ||
			(node.type === 'ExportNamedDeclaration' && node.source);
		if (!is_from || node.importKind === 'type' || node.exportKind === 'type') continue;
		const value = node.source?.value;
		if (typeof value === 'string') specs.push(value);
	}
	return specs;
}

/** `const a = undefined, b = undefined;` for the given locals (empty string for none). */
function undefined_consts(locals: readonly string[]): string {
	return locals.length ? `const ${locals.map((l) => `${l} = undefined`).join(', ')};` : '';
}

/**
 * The registry's source with its MARKS blanked and everything else kept, or `null` when it does not
 * parse (the caller falls back to the names-only stub). A mark is an import whose `with { … }`
 * carries a region key (`region_keys`: the app's wake / render / region / preset names), or a
 * component handed to `import.meta.og.asRegion(…)`. Each blanked binding becomes
 * `const X = undefined` so the module still links; the client leg never runs it anyway.
 */
export function registry_client_source(
	source: string,
	file: string,
	region_keys: ReadonlySet<string>
): string | null {
	const parsed = parse_module(source, file);
	if (!parsed.ok || !parsed.program) return null;
	const body = (parsed.program as EsNode).body as EsNode[];
	const edits: { start: number; end: number; text: string }[] = [];

	// `import.meta.og.asRegion(Comp, …)` → `undefined`; its component import is a mark too.
	// `import.meta.og.regions(glob)` (a held-region registry the compiler expands into marked
	// imports) → `{}`: every entry it would mint is a mark.
	const as_region_args = new Set<string>();
	walk(parsed.program as never, {
		enter(n) {
			const node = n as unknown as EsNode;
			if (node.type !== 'CallExpression') return;
			if (is_og_macro(node.callee, 'regions')) {
				edits.push({ start: node.start, end: node.end, text: '({})' });
				this.skip();
				return;
			}
			if (!is_og_macro(node.callee, 'asRegion')) return;
			const arg = node.arguments?.[0];
			if (arg?.type === 'Identifier') as_region_args.add(arg.name);
			edits.push({ start: node.start, end: node.end, text: 'undefined' });
			this.skip();
		}
	});

	for (const node of body) {
		if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
		const specifiers = (node.specifiers ?? []) as EsNode[];
		const marked = ((node.attributes ?? []) as EsNode[]).some((a) =>
			region_keys.has(a.key?.name ?? a.key?.value)
		);
		const dropped = specifiers.filter(
			(s) => marked || (s.importKind !== 'type' && as_region_args.has(s.local.name))
		);
		if (!dropped.length) continue;
		const kept = specifiers.filter((s) => !dropped.includes(s));
		const consts = undefined_consts(dropped.map((s) => s.local.name));
		if (!kept.length) {
			edits.push({ start: node.start, end: node.end, text: consts });
			continue;
		}
		// Some specifiers stay (a barrel import handing one name to asRegion, others plain).
		const head = kept
			.filter((s) => s.type !== 'ImportSpecifier')
			.map((s) => source.slice(s.start, s.end));
		const named = kept
			.filter((s) => s.type === 'ImportSpecifier')
			.map((s) => source.slice(s.start, s.end));
		if (named.length) head.push(`{ ${named.join(', ')} }`);
		const spec = source.slice(node.source.start, node.source.end);
		edits.push({
			start: node.start,
			end: node.end,
			text: `import ${head.join(', ')} from ${spec}; ${consts}`
		});
	}

	if (!edits.length) return source;
	edits.sort((a, b) => b.start - a.start);
	let out = source;
	for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return out;
}

const NAMES_PARAM = '?names=';
const EXPORT_DECL_G =
	/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_G = /^\s*export\s*\{([^}]*)\}/gm;
const EXPORT_DEFAULT_RE = /^\s*export\s+default\b/m;
const IMPORT_FROM_G =
	/import\s+(?:type\s+)?([^'";]*?)\s*from\s*(['"])([^'"]+)\2/g;
const IMPORT_SIDE_EFFECT_RE = /^\s*$/;
const AS_RE = /\s+as\s+/;
const WS_G = /\s+/g;

/** Root-relative posix path → the stub id. `names` are the exports the stub must declare. */
export function registry_stub_id(rel_posix: string, names: Iterable<string>): string {
	const sorted = [...new Set(names)].sort();
	return `${REGISTRY_STUB_PREFIX}${encodeURIComponent(rel_posix)}.js${NAMES_PARAM}${sorted.map(encodeURIComponent).join(',')}`;
}

/** True for a (resolved or bare) stub id. */
export function is_registry_stub_id(id: string): boolean {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(REGISTRY_STUB_PREFIX);
}

/** The export names a stub id carries (`default` included when the registry has one). */
export function registry_stub_names(id: string): string[] {
	const at = id.indexOf(NAMES_PARAM);
	if (at < 0) return [];
	return id
		.slice(at + NAMES_PARAM.length)
		.split(',')
		.filter(Boolean)
		.map(decodeURIComponent);
}

/** The stub module's source: every name as `undefined`, so the host links and nothing is shipped. */
export function registry_stub_source(names: readonly string[]): string {
	let out = '';
	for (const n of names) {
		if (n === 'default') out += 'export default undefined;\n';
		else if (/^[A-Za-z_$][\w$]*$/.test(n)) out += `export const ${n} = undefined;\n`;
	}
	return out || 'export {};\n';
}

/**
 * The names a module exports, scanned from its source (declarations, `export { a, b as c }`,
 * `export default`). A textual scan — registries are plain TypeScript lists, and a name the scan
 * misses is covered by {@link imported_names} (what the host actually asks for).
 */
export function export_names(source: string): Set<string> {
	const names = new Set<string>();
	EXPORT_DECL_G.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = EXPORT_DECL_G.exec(source))) names.add(m[1]);
	EXPORT_LIST_G.lastIndex = 0;
	while ((m = EXPORT_LIST_G.exec(source))) {
		for (const part of m[1].split(',')) {
			const p = part.trim();
			if (!p) continue;
			const [, alias] = p.split(AS_RE);
			const name = (alias ?? p).trim();
			if (name === 'default' || /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	if (EXPORT_DEFAULT_RE.test(source)) names.add('default');
	return names;
}

/**
 * The names `importer_source` imports from `spec` (default → `default`, named → their exported
 * names, `* as ns` → nothing extra: a namespace import links against whatever the stub declares).
 */
export function imported_names(importer_source: string, spec: string): Set<string> {
	const names = new Set<string>();
	IMPORT_FROM_G.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = IMPORT_FROM_G.exec(importer_source))) {
		if (m[3] !== spec) continue;
		const clause = m[1].replace(WS_G, ' ').trim();
		if (IMPORT_SIDE_EFFECT_RE.test(clause)) continue;
		const brace = clause.indexOf('{');
		const head = (brace >= 0 ? clause.slice(0, brace) : clause).replace(',', '').trim();
		if (head && !head.startsWith('*')) names.add('default');
		if (brace >= 0) {
			for (const part of clause.slice(brace + 1, clause.indexOf('}')).split(',')) {
				const p = part.trim().replace(/^type\s+/, '');
				if (!p) continue;
				const [exported] = p.split(AS_RE);
				const name = exported.trim();
				if (name) names.add(name);
			}
		}
	}
	return names;
}
