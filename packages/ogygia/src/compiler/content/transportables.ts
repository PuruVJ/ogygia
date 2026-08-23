/**
 * Registration for transportable classes (`static [import.meta.og.wire]` codecs).
 *
 * ALIAS-PROOF BY DESIGN: the build never tries to recognize the codec key — it registers
 * every *exported class declaration* (found by parsing, so strings/comments never
 * false-match), and the RUNTIME decides which matter: `__register_transportable(tag, Cls)`
 * is a no-op unless the class actually carries `Symbol.for('ogygia.wire')`. So
 * `const k = import.meta.og.wire` hops, minified keys — every spelling works (the construct rewrites to the symbol wherever it appears).
 *
 * Tags are root-relative module path + export name: identical in the server build and every
 * island bundle with zero coordination. Registrations import from `ogygia/internal` — a
 * re-export barrel, so tree-shaking keeps island component code out of a tagged `.svelte.ts`
 * state chunk.
 *
 * Constraint: a top-level `export class X` (declaration or `export { X }`). Default exports
 * and class expressions have no stable name to tag by.
 */
// Parse via the injectable oxc seam (parse/oxc.ts), NOT `import { parseSync } from 'vite'` — importing
// the Node `vite` package here dragged the whole of vite onto the compiler's hot path, which is what
// kept the FULL driver out of a browser worker (the Observatory). `set_parser` already installs the
// sync oxc parser in every realm (Node default; the worker installs rolldown-browser's).
import { parse_module } from '../parse/oxc.js';

const CLASS_KW = /\bclass\b/;
const MODULE_KW = /\bmodule\b/;
const CONTEXT_MODULE_ATTR = /context\s*=\s*["']module["']/;
const SVELTE_EXT = /\.svelte$/;

/** Marker that a module already carries generated registrations (idempotence). */
const GENERATED_MARK =
	'// ogygia: generated registration (transportable codecs + createContext tags)';

/** Parse a module to its top-level statements once (TS/JS inferred from `id_n`); null on error. */
function parse_body(code: string, id_n: string): AstNode[] | null {
	// `parseSync` never throws — syntax errors land in `.errors`, which the real compiler reports.
	try {
		const result = parse_module(code, id_n);
		if (!result.ok || !result.program) return null;
		return (result.program as { body?: AstNode[] }).body ?? [];
	} catch {
		return null;
	}
}

/** Collect names of top-level classes that are exported (declaration or `export {}`). */
function exportedClassNames(code: string, id_n: string): string[] {
	const body = parse_body(code, id_n);
	return body ? exportedClassNamesFromBody(body) : [];
}

function exportedClassNamesFromBody(body: AstNode[]): string[] {
	const classNames = new Set<string>(); // every top-level class declaration
	const exported = new Set<string>(); // subset that is exported
	for (const node of body) {
		if (node.type === 'ClassDeclaration' && node.id) {
			classNames.add(node.id.name);
		} else if (node.type === 'ExportNamedDeclaration') {
			if (node.declaration?.type === 'ClassDeclaration' && node.declaration.id?.name) {
				classNames.add(node.declaration.id.name);
				exported.add(node.declaration.id.name);
			}
			// `export { Foo, Bar as Baz }` — the LOCAL name must be a class (resolved after the loop).
			if (!node.source) {
				for (const spec of node.specifiers ?? []) {
					if (spec.local?.type === 'Identifier') exported.add(spec.local.name);
				}
			}
		}
	}
	return [...exported].filter((name) => classNames.has(name));
}

interface AstNode {
	type: string;
	id?: { name: string } | null;
	declaration?: VarDecl | AstNode | null;
	source?: unknown;
	specifiers?: { local?: { type: string; name: string } }[];
	body?: { body?: ClassMember[] } | AstNode[];
	static?: boolean;
	computed?: boolean;
}
interface CallInit {
	type: string;
	callee?: { type?: string; name?: string; property?: { name?: string } };
}
interface VarDecl {
	type: string;
	id?: { type?: string; name?: string } | null;
	kind?: string;
	declarations?: { id?: { type?: string; name?: string }; init?: CallInit | null }[];
}

/**
 * Exported consts whose initializer is a `createContext(...)` call — `export const cart =
 * createContext<Cart>()`. Tagged by `module#export` so a provider and every consumer island agree
 * on the context identity (same alias-proof scheme as `wire`). Covers `createContext(...)` and
 * `<ns>.createContext(...)`.
 */
function contextExportNames(code: string, id_n: string): string[] {
	if (!code.includes('createContext')) return [];
	const body = parse_body(code, id_n);
	return body ? contextExportNamesFromBody(body) : [];
}

function contextExportNamesFromBody(body: AstNode[]): string[] {
	const names: string[] = [];
	for (const node of body) {
		if (node.type !== 'ExportNamedDeclaration') continue;
		const decl = node.declaration as VarDecl | null | undefined;
		if (!decl || decl.type !== 'VariableDeclaration') continue;
		for (const d of decl.declarations ?? []) {
			const init = d.init;
			if (d.id?.type !== 'Identifier' || !d.id.name || init?.type !== 'CallExpression') continue;
			const callee = init.callee;
			const isCreate =
				(callee?.type === 'Identifier' && callee.name === 'createContext') ||
				(callee?.type === 'MemberExpression' && callee.property?.name === 'createContext');
			if (isCreate) names.push(d.id.name);
		}
	}
	return names;
}
interface ClassMember {
	type: string;
	static?: boolean;
	computed?: boolean;
}

/**
 * Does this module define an exported class carrying a transportable codec? Used to build
 * the eager-registration manifest so islands never need a manual `import` of the class.
 *
 * Signal: an exported class with a `static` member whose key is COMPUTED (`static [x] = …` /
 * `static [x]() {}`) — every rewritten wire member is exactly that — OR, pre-rewrite, the
 * `import.meta.og.wire` construct marker (prescan reads RAW source, where the blessed spelling
 * `static wire = import.meta.og.wire()` is not yet a computed member). A false positive (an
 * unrelated computed static, the marker in a comment) only eagerly loads one extra module; a
 * transportable class is never missed.
 */
export function moduleHasTransportable(code: string, id_n: string): boolean {
	if (!CLASS_KW.test(code) || !code.includes('static')) return false;
	if (code.includes('import.meta.og.wire')) return true;
	let body: AstNode[];
	try {
		const result = parse_module(code, id_n);
		if (!result.ok || !result.program) return false;
		body = (result.program as { body?: AstNode[] }).body ?? [];
	} catch {
		return false;
	}
	const isTransportableClass = (cls: AstNode | null | undefined): boolean => {
		const members = (cls?.body as { body?: ClassMember[] } | undefined)?.body ?? [];
		return members.some((m) => m.static === true && m.computed === true);
	};
	for (const node of body) {
		if (node.type === 'ClassDeclaration' && isTransportableClass(node)) return true;
		if (
			node.type === 'ExportNamedDeclaration' &&
			node.declaration?.type === 'ClassDeclaration' &&
			isTransportableClass(node.declaration as AstNode)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Append `__register_transportable` calls for every exported class in this module. Returns
 * the augmented code, or null when there is no exported class. Append-only — the module's
 * existing sourcemap stays valid.
 */
export function appendTransportRegistrations(
	code: string,
	id_n: string,
	root: string,
	pathModule: { relative: (from: string, to: string) => string }
): string | null {
	if (code.includes(GENERATED_MARK)) return null;
	// Cheap gates — skip parsing modules that have neither a class nor a createContext call.
	const maybeClass = CLASS_KW.test(code);
	const maybeCtx = code.includes('createContext');
	if (!maybeClass && !maybeCtx) return null;

	// Parse ONCE and feed both detectors (a module with both a class and a createContext used to
	// parse twice).
	const body = parse_body(code, id_n);
	if (!body) return null;
	const classes = maybeClass ? exportedClassNamesFromBody(body) : [];
	const contexts = maybeCtx ? contextExportNamesFromBody(body) : [];
	if (classes.length === 0 && contexts.length === 0) return null;

	const rel = pathModule.relative(root, id_n).split('\\').join('/');
	return code + registrationBlock(rel, classes, contexts) + '\n';
}

function registrationBlock(rel: string, classes: string[], contexts: string[]): string {
	const imports: string[] = [];
	if (classes.length) imports.push('__register_transportable as __OGT');
	if (contexts.length) imports.push('__tag_context as __OGC');
	const lines = [
		'',
		'// ogygia: generated registration (transportable codecs + createContext tags)',
		`import { ${imports.join(', ')} } from 'ogygia/internal';`
	];
	for (const name of classes) lines.push(`__OGT(${JSON.stringify(rel + '#' + name)}, ${name});`);
	for (const name of contexts) lines.push(`__OGC(${JSON.stringify(rel + '#' + name)}, ${name});`);
	return lines.join('\n');
}

/**
 * A `.svelte` component can `export class X` from its `<script module>` (instance-`<script>`
 * classes can't be exported, so they never travel). Find the module script and treat its
 * body like any other module: same detection, same registration, injected before the block's
 * closing tag. The class is tagged by the `.svelte` path, and the manifest side-effect-imports
 * the component to run that registration on the client.
 */
function moduleScriptOf(code: string): { body: string; injectAt: number } | null {
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) {
		const attrs = m[1];
		if (MODULE_KW.test(attrs) || CONTEXT_MODULE_ATTR.test(attrs)) {
			const bodyStart = m.index + m[0].indexOf('>', 0) + 1;
			const bodyEnd = re.lastIndex - '</script>'.length;
			return { body: code.slice(bodyStart, bodyEnd), injectAt: bodyEnd };
		}
	}
	return null;
}

/** True if a `.svelte` file's `<script module>` exports a transportable class. */
export function svelteModuleHasTransportable(code: string, id_n: string): boolean {
	if (!code.includes('module') || !CLASS_KW.test(code)) return false;
	const mod = moduleScriptOf(code);
	if (!mod) return false;
	// Parse the module body as TS (Svelte module scripts allow `lang="ts"`).
	return moduleHasTransportable(mod.body, id_n.replace(SVELTE_EXT, '.svelte.ts'));
}

/** Inject registration for a `.svelte` module script's exported transportable classes. */
export function appendSvelteModuleRegistrations(
	code: string,
	id_n: string,
	root: string,
	pathModule: { relative: (from: string, to: string) => string }
): string | null {
	if (code.includes(GENERATED_MARK) || !CLASS_KW.test(code)) return null;
	const mod = moduleScriptOf(code);
	if (!mod) return null;
	const exported = exportedClassNames(mod.body, id_n.replace(SVELTE_EXT, '.svelte.ts'));
	if (exported.length === 0) return null;
	const rel = pathModule.relative(root, id_n).split('\\').join('/');
	const block = '\n' + registrationBlock(rel, exported, []) + '\n';
	return code.slice(0, mod.injectAt) + block + code.slice(mod.injectAt);
}
