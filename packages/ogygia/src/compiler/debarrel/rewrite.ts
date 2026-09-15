/**
 * The importer rewrite: every `import { … } from 'barrel'` whose names the index can place is
 * replaced, in place, by one import per leaf — attributes preserved, local names unchanged, type
 * modifiers kept. Names the index cannot place stay on the barrel; a pure barrel whose names all
 * moved loses its import, an impure (forced) one keeps a bare `import 'barrel'` so its own code
 * still runs. Pure over a lookup function and a code string; sourcemap via magic-string.
 */
import MagicString from 'magic-string';
import type { ExportMap, Leaf } from './barrel.js';
import { analyze_imports, type ImportDecl, type ImportSpec } from './parse.js';

export interface RewriteMove {
	barrel: string;
	names: string[];
	leaves: string[];
}

export interface RewriteResult {
	code: string;
	map: ReturnType<MagicString['generateMap']>;
	moves: RewriteMove[];
}

export interface Lookup {
	/** The barrel's export map for the import's specifier, or null when the import is left alone. */
	(source: string): Promise<ExportMap | null>;
}

export interface RewritePolicy {
	/** Leave this declaration exactly as written (ogygia: an import that carries region marks). */
	skip?: (decl: ImportDecl) => boolean;
}

const BAD_IDENT_RE = /[^A-Za-z0-9_$\u0080-\uFFFF]/;
const JS_STRING_ESCAPE_RE = /[\\'\n\r\u2028\u2029]/g;
const JS_STRING_ESCAPES: Record<string, string> = {
	'\\': '\\\\',
	"'": "\\'",
	'\n': '\\n',
	'\r': '\\r',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};

const quote = (s: string) => "'" + s.replace(JS_STRING_ESCAPE_RE, (c) => JS_STRING_ESCAPES[c]) + "'";

/** Rewrite one module's import declarations. `offset` maps positions when `code` is a slice of a
 *  bigger file (a Svelte `<script>` block): edits are applied to `ms` at `offset + pos`. `id`
 *  names the code for the parser (its extension picks the dialect). */
export async function rewrite_imports(
	code: string,
	id: string,
	lookup: Lookup,
	ms: MagicString,
	offset = 0,
	policy: RewritePolicy = {}
): Promise<RewriteMove[]> {
	const decls = analyze_imports(code, id);
	if (!decls) return []; // a syntax error is the compiler's to report, not ours
	const moves: RewriteMove[] = [];
	for (const decl of decls) {
		if (decl.side_effect) continue; // `import 'x'` — the module wants to run, leave it
		if (decl.type_only) continue; // `import type { … }` is erased: no graph edge to shorten
		if (decl.specs.some((s) => s.kind === 'namespace')) continue; // `import * as B` — the whole thing, by design
		if (policy.skip && policy.skip(decl)) continue;
		const map = await lookup(decl.source);
		if (!map || !map.rewritable) continue;

		// Group by leaf MODULE: one import line per leaf, each specifier keeping its own leaf name
		// (`{ a, b as bee }` from one file → `import { a, b as bee }`).
		const by_leaf = new Map<string, { id: string; namespace: boolean; items: { spec: ImportSpec; leaf: Leaf }[] }>();
		const stays: ImportSpec[] = [];
		for (const spec of decl.specs) {
			const entry = map.entries.get(spec.imported);
			if (!entry || entry === 'own' || entry === 'ambiguous') {
				stays.push(spec);
				continue;
			}
			const namespace = 'namespace' in entry;
			const key = namespace ? entry.id + '\0*' : entry.id;
			const group = by_leaf.get(key) ?? { id: entry.id, namespace, items: [] };
			group.items.push({ spec, leaf: entry });
			by_leaf.set(key, group);
		}
		if (by_leaf.size === 0) continue;

		const lines: string[] = [];
		const leaves: string[] = [];
		const moved: string[] = [];
		for (const group of by_leaf.values()) {
			leaves.push(group.id);
			const specs = group.items.map((i) => i.spec);
			for (const s of specs) moved.push(s.imported);
			const attrs = decl.attributes;
			if (group.namespace) {
				for (const s of specs) lines.push(`import * as ${s.local} from ${quote(group.id)}${attrs};`);
				continue;
			}
			const type_all = decl.type_only || specs.every((s) => s.type_only);
			const type_kw = type_all ? 'type ' : '';
			const named: string[] = [];
			let default_local: string | null = null;
			const more_defaults: string[] = [];
			for (const { spec: s, leaf } of group.items) {
				const target = 'namespace' in leaf ? '*' : leaf.name;
				if (target === 'default') {
					// `import { X } from 'barrel'` where the barrel did `export { default as X } from leaf`
					// → `import X from leaf`; a second default alias of the same leaf gets its own line
					if (default_local === null) default_local = s.local;
					else more_defaults.push(s.local);
					continue;
				}
				const mod = !type_all && s.type_only ? 'type ' : '';
				// the leaf's export name may itself be a string (`export { x as "a-b" }` in the leaf):
				// `import { "a-b" as local }` is legal ESM, the string form is what it takes
				const name = BAD_IDENT_RE.test(target) ? JSON.stringify(target) : target;
				named.push(target === s.local ? `${mod}${target}` : `${mod}${name} as ${s.local}`);
			}
			if (default_local !== null && named.length)
				lines.push(
					`import ${type_kw}${default_local}, { ${named.join(', ')} } from ${quote(group.id)}${attrs};`
				);
			else if (default_local !== null)
				lines.push(`import ${type_kw}${default_local} from ${quote(group.id)}${attrs};`);
			else lines.push(`import ${type_kw}{ ${named.join(', ')} } from ${quote(group.id)}${attrs};`);
			for (const local of more_defaults)
				lines.push(`import ${type_kw}${local} from ${quote(group.id)}${attrs};`);
		}
		// what stays on the barrel: the names we could not place, the default when the barrel owns
		// it — or, for a forced impure barrel with nothing left, a bare import for its side effects
		if (stays.length) {
			const type_kw = decl.type_only ? 'type ' : '';
			const def = stays.find((s) => s.kind === 'default');
			const named = stays
				.filter((s) => s.kind === 'named')
				.map(
					(s) =>
						`${!decl.type_only && s.type_only ? 'type ' : ''}${s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`}`
				);
			const parts = [def ? def.local : null, named.length ? `{ ${named.join(', ')} }` : null].filter(
				Boolean
			);
			lines.push(`import ${type_kw}${parts.join(', ')} from ${quote(decl.source)}${decl.attributes};`);
		} else if (!map.pure) {
			lines.push(`import ${quote(decl.source)}${decl.attributes};`);
		}
		ms.overwrite(offset + decl.start, offset + decl.end, lines.join('\n'));
		moves.push({ barrel: map.id, names: moved, leaves: [...new Set(leaves)] });
	}
	return moves;
}

/** Whole-file rewrite for a JS/TS module. */
export async function rewrite_module(
	code: string,
	id: string,
	lookup: Lookup,
	policy: RewritePolicy = {}
): Promise<RewriteResult | null> {
	const ms = new MagicString(code);
	const moves = await rewrite_imports(code, id, lookup, ms, 0, policy);
	if (moves.length === 0) return null;
	return { code: ms.toString(), map: ms.generateMap({ hires: true }), moves };
}
