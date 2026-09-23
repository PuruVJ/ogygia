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
 */
export const REGISTRY_STUB_PREFIX = 'virtual:ogygia/registry-stub/';

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
