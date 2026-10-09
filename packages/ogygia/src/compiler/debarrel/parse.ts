/**
 * Module analysis on the compiler's parser ({@link parse_module} — oxc through Vite, TS understood,
 * byte offsets exact): the import declarations an importer has, and the export SHAPE of a candidate
 * barrel. The id's extension picks the dialect, like everywhere else in the compiler; a Svelte
 * script block is parsed under a synthetic `<file>.svelte.ts` / `.svelte.js` id.
 */
import { parse_module } from '../parse/oxc.js';

export interface ImportSpec {
	/** `default` | `namespace` | `named` */
	kind: 'default' | 'namespace' | 'named';
	/** the exported name asked for (`x` in `{ x as y }`, `default` for a default import) */
	imported: string;
	/** the local binding */
	local: string;
	/** `import { type T }` */
	type_only: boolean;
}

export interface ImportDecl {
	start: number;
	end: number;
	source: string;
	/** the verbatim ` with { … }` clause (leading space included), '' when none */
	attributes: string;
	/** the attribute keys (`wake` in `with { wake: 'load' }`) — what a mark-aware caller inspects */
	attribute_keys: string[];
	/** `import type { … }` — the whole declaration is type-only */
	type_only: boolean;
	/** bare `import 'x'` */
	side_effect: boolean;
	specs: ImportSpec[];
}

/** What a barrel says about one of its exported names. */
export type ExportRecord =
	| { kind: 'reexport'; exported: string; imported: string; source: string; type_only: boolean }
	| { kind: 'star'; source: string; type_only: boolean }
	| { kind: 'star_ns'; exported: string; source: string }
	| { kind: 'own'; exported: string };

export interface ModuleShape {
	imports: ImportDecl[];
	exports: ExportRecord[];
	/** A PURE barrel: nothing but imports, re-exports, type declarations and `export {}`. */
	pure: boolean;
	/** Own names (declared in this module) that are exported. */
	own: Set<string>;
}

// A minimal view of the ESTree nodes we read (oxc's estree output).
interface Node {
	type: string;
	start: number;
	end: number;
	[k: string]: unknown;
}
interface Ident {
	type: 'Identifier' | 'Literal';
	name?: string;
	value?: unknown;
}

const name_of = (n: Ident | undefined): string => {
	if (!n) return '';
	if (n.type === 'Identifier') return n.name ?? '';
	return typeof n.value === 'string' ? n.value : String(n.value);
};

/** The clause runs from ` with` (or the legacy ` assert`) after the source literal to the end. */
const ATTRIBUTES_CLAUSE_RE = /\s+(?:with|assert)\s*\{[\s\S]*\}/;
const TRAILING_SEMI_RE = /;\s*$/;

/** The parsed program body, or null on a syntax error (the real compiler reports those). */
function program_body(code: string, id: string): Node[] | null {
	const { program, ok } = parse_module(code, id);
	if (!ok || !program) return null;
	return program.body as Node[];
}

/** The verbatim ` with { … }` text of a declaration, from the source (oxc keeps `attributes`). */
function attributes_text(code: string, node: Node): string {
	const attrs = node.attributes as Node[] | undefined;
	if (!attrs || attrs.length === 0) return '';
	const source = node.source as Node;
	const tail = code.slice(source.end, node.end);
	const m = ATTRIBUTES_CLAUSE_RE.exec(tail);
	return m ? m[0].replace(TRAILING_SEMI_RE, '') : '';
}

function attribute_keys(node: Node): string[] {
	const attrs = node.attributes as Node[] | undefined;
	if (!attrs || attrs.length === 0) return [];
	return attrs.map((a) => name_of(a.key as Ident));
}

function imports_of(code: string, body: Node[]): ImportDecl[] {
	const out: ImportDecl[] = [];
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue;
		const source = node.source as Node & { value: string };
		const specifiers = (node.specifiers as Node[]) ?? [];
		const specs: ImportSpec[] = specifiers.map((s) => {
			const local = name_of(s.local as Ident);
			if (s.type === 'ImportDefaultSpecifier')
				return { kind: 'default', imported: 'default', local, type_only: false };
			if (s.type === 'ImportNamespaceSpecifier')
				return { kind: 'namespace', imported: '*', local, type_only: false };
			return {
				kind: 'named',
				imported: name_of(s.imported as Ident),
				local,
				type_only: s.importKind === 'type'
			};
		});
		out.push({
			start: node.start,
			end: node.end,
			source: source.value,
			attributes: attributes_text(code, node),
			attribute_keys: attribute_keys(node),
			type_only: node.importKind === 'type',
			side_effect: specifiers.length === 0,
			specs
		});
	}
	return out;
}

/**
 * Every top-level import of the module, with ranges the rewriter overwrites. Declarations that
 * cannot be rewritten (bare side-effect imports, namespace imports) are returned too, flagged, so
 * a caller sees the whole picture. Null on a syntax error.
 */
export function analyze_imports(code: string, id: string): ImportDecl[] | null {
	const body = program_body(code, id);
	return body ? imports_of(code, body) : null;
}

/** Declarations erased at runtime — they never make a module impure. (Enums have runtime shape.) */
const TYPE_ONLY_DECLS = new Set([
	'TSTypeAliasDeclaration',
	'TSInterfaceDeclaration',
	'TSDeclareFunction',
	'TSModuleDeclaration'
]);

/**
 * The export shape of a module. `pure` is the barrel test: the module contributes NO code of its
 * own — every statement is an import, a re-export, an `export {}` of imported bindings, a type
 * declaration, or an empty export. A module with any own declaration, expression statement, or
 * `export default <expr>` is IMPURE (it runs something), and is only rewritten when forced.
 * Null on a syntax error (or a file oxc cannot read as a module).
 */
export function analyze_exports(code: string, id: string): ModuleShape | null {
	const body = program_body(code, id);
	if (!body) return null;
	const imports = imports_of(code, body);
	// local binding → what it came from, for `import { a } from './x'; export { a as b }`
	const bound = new Map<string, { source: string; imported: string; kind: ImportSpec['kind'] }>();
	for (const d of imports)
		for (const s of d.specs) bound.set(s.local, { source: d.source, imported: s.imported, kind: s.kind });

	const exports: ExportRecord[] = [];
	const own = new Set<string>();
	let pure = true;

	for (const node of body) {
		switch (node.type) {
			case 'ImportDeclaration':
				continue;
			case 'ExportAllDeclaration': {
				const source = (node.source as Node & { value: string }).value;
				const exported = node.exported as Ident | null;
				if (exported) exports.push({ kind: 'star_ns', exported: name_of(exported), source });
				else exports.push({ kind: 'star', source, type_only: node.exportKind === 'type' });
				continue;
			}
			case 'ExportNamedDeclaration': {
				const decl = node.declaration as Node | null;
				if (decl) {
					// `export const a = …` / `export function f` / `export class C` / `export type T` …
					if (TYPE_ONLY_DECLS.has(decl.type)) {
						for (const n of declared_names(decl)) exports.push({ kind: 'own', exported: n });
						continue; // erased at runtime: does not make the module impure
					}
					pure = false;
					for (const n of declared_names(decl)) {
						own.add(n);
						exports.push({ kind: 'own', exported: n });
					}
					continue;
				}
				const source = node.source ? (node.source as Node & { value: string }).value : null;
				const specifiers = (node.specifiers as Node[]) ?? [];
				const type_decl = node.exportKind === 'type';
				for (const s of specifiers) {
					const local = name_of(s.local as Ident);
					const exported = name_of(s.exported as Ident);
					const type_only = type_decl || s.exportKind === 'type';
					if (source) {
						exports.push({ kind: 'reexport', exported, imported: local, source, type_only });
						continue;
					}
					// `export { a as b }` of a binding: imported → a re-export through the binding;
					// declared here → own.
					const b = bound.get(local);
					if (b) {
						if (b.kind === 'namespace') exports.push({ kind: 'star_ns', exported, source: b.source });
						else
							exports.push({
								kind: 'reexport',
								exported,
								imported: b.imported,
								source: b.source,
								type_only
							});
					} else {
						own.add(exported);
						exports.push({ kind: 'own', exported });
						if (!type_only) pure = false;
					}
				}
				continue;
			}
			case 'ExportDefaultDeclaration': {
				const decl = node.declaration as Node;
				// `export default imported` (an identifier bound by an import) is a re-export.
				if (decl.type === 'Identifier') {
					const b = bound.get(name_of(decl as unknown as Ident));
					if (b && b.kind !== 'namespace') {
						exports.push({
							kind: 'reexport',
							exported: 'default',
							imported: b.imported,
							source: b.source,
							type_only: false
						});
						continue;
					}
				}
				pure = false;
				own.add('default');
				exports.push({ kind: 'own', exported: 'default' });
				continue;
			}
			default:
				// type-only declarations are erased; anything else is code the module runs
				if (TYPE_ONLY_DECLS.has(node.type)) continue;
				if (node.type === 'EmptyStatement') continue;
				pure = false;
		}
	}
	return { imports, exports, pure, own };
}

/** Names a declaration binds (`const { a, b } = …`, `function f`, `class C`, `enum E`, `type T`). */
function declared_names(decl: Node): string[] {
	const out: string[] = [];
	const id = decl.id as Ident | undefined;
	if (id && id.type === 'Identifier') out.push(name_of(id));
	const declarations = decl.declarations as Node[] | undefined;
	if (declarations) for (const d of declarations) collect_pattern(d.id as Node, out);
	return out;
}

function collect_pattern(p: Node, out: string[]): void {
	if (!p) return;
	switch (p.type) {
		case 'Identifier':
			out.push(name_of(p as unknown as Ident));
			return;
		case 'ObjectPattern':
			for (const prop of p.properties as Node[])
				collect_pattern((prop.type === 'RestElement' ? prop.argument : prop.value) as Node, out);
			return;
		case 'ArrayPattern':
			for (const el of p.elements as (Node | null)[]) if (el) collect_pattern(el, out);
			return;
		case 'AssignmentPattern':
			collect_pattern(p.left as Node, out);
			return;
		case 'RestElement':
			collect_pattern(p.argument as Node, out);
			return;
	}
}
