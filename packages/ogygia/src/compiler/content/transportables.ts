/**
 * Registration for transportable classes (`static [import.meta.og.wire]` codecs).
 *
 * Registers ONLY exported classes that actually carry a wire codec — NOT every exported class.
 * A plain `export class Foo {}` must never be registered, because the registration appends an
 * `import … from 'ogygia/internal/register'`, and dragging that into an unrelated module (or a
 * workspace package that doesn't even depend on ogygia) breaks its resolution for nothing.
 * Detection is exact, not heuristic: by the time this runs the wire macro has already normalized
 * `static wire = import.meta.og.wire(…)` into `static [Symbol.for('ogygia.wire')] = …`, so a class
 * is transportable iff it has that member (the pre-rewrite call form is matched too, defensively).
 * The macro is name-locked to `static wire`, so there is exactly one shape to find — no aliasing.
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
// A real (pre-transform) wire codec member: `static <name> = import.meta.og.wire(…)`. Tight on
// purpose — the prescan uses this to catch a wire class BEFORE the macro rewrites it to the computed
// `static [WIRE_EXPR]` form (which the AST check below sees). A BARE textual mention of the macro (a
// comment or string that merely names it — e.g. the Observatory's own REPL analysis code) must NOT
// read as a transportable, or the module gets side-effect-imported into every realm by the eager
// registration manifest — including a Web Worker that references `self`, which then crashes on SSR.
const WIRE_STATIC_MEMBER = /\bstatic\s+#?\w+\s*=\s*import\.meta\.og\.wire\b/;
const MODULE_KW = /\bmodule\b/;
const CONTEXT_MODULE_ATTR = /context\s*=\s*["']module["']/;
const SVELTE_EXT = /\.svelte$/;
/** Every `<script …>…</script>` block (shared `g` regex — reset `lastIndex` per scan). */
const SCRIPT_BLOCK_G = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

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

/** Collect names of top-level exported classes that carry a wire codec (and only those). */
function exportedWireClassNames(code: string, id_n: string): string[] {
	const body = parse_body(code, id_n);
	return body ? exportedWireClassNamesFromBody(body) : [];
}

function exportedWireClassNamesFromBody(body: AstNode[]): string[] {
	const classNodes = new Map<string, AstNode>(); // every top-level class declaration, by name
	const exported = new Set<string>(); // subset that is exported
	for (const node of body) {
		if (node.type === 'ClassDeclaration' && node.id) {
			classNodes.set(node.id.name, node);
		} else if (node.type === 'ExportNamedDeclaration') {
			if (node.declaration?.type === 'ClassDeclaration' && node.declaration.id?.name) {
				classNodes.set(node.declaration.id.name, node.declaration as AstNode);
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
	// Only classes that actually carry a wire codec — a plain exported class is not transportable.
	return [...exported].filter((name) => {
		const cls = classNodes.get(name);
		return !!cls && classHasWireMember(cls);
	});
}

/** Minimal shape of the expression nodes the wire checks below walk. */
interface ExprNode {
	type?: string;
	name?: string;
	computed?: boolean;
	value?: unknown;
	callee?: ExprNode;
	object?: ExprNode;
	property?: { name?: string };
	meta?: { name?: string };
	arguments?: { type?: string; value?: unknown }[];
}

/**
 * A class carrying a wire codec. Post-macro (the usual case here — macros run before this pass):
 * `static [Symbol.for('ogygia.wire')] = …`. Pre-macro, defensively: `static <name> =
 * import.meta.og.wire(…)`. Anything else is a plain class and must NOT be registered.
 */
function classHasWireMember(cls: AstNode): boolean {
	const members = (cls.body as { body?: ClassMember[] } | undefined)?.body ?? [];
	return members.some((m) => {
		if (m.static !== true) return false;
		if (m.computed === true && isWireSymbolKey(m.key)) return true; // static [Symbol.for('ogygia.wire')]
		return isWireMacroCall(m.value); // static wire = import.meta.og.wire(…)
	});
}

/** `Symbol.for('ogygia.wire')` — the computed key the wire macro emits. */
function isWireSymbolKey(key: unknown): boolean {
	const k = key as ExprNode | undefined;
	if (k?.type !== 'CallExpression') return false;
	const callee = k.callee;
	if (
		callee?.type !== 'MemberExpression' ||
		callee.object?.name !== 'Symbol' ||
		callee.property?.name !== 'for'
	) {
		return false;
	}
	const arg = k.arguments?.[0];
	return (
		!!arg && (arg.type === 'StringLiteral' || arg.type === 'Literal') && arg.value === 'ogygia.wire'
	);
}

/** `import.meta.og.wire(…)` — the raw construct, before the macro rewrites it to the symbol key. */
function isWireMacroCall(value: unknown): boolean {
	const v = value as ExprNode | undefined;
	if (v?.type !== 'CallExpression') return false;
	const callee = v.callee; // (import.meta.og).wire
	if (callee?.type !== 'MemberExpression' || callee.computed || callee.property?.name !== 'wire') {
		return false;
	}
	const og = callee.object; // import.meta.og
	if (og?.type !== 'MemberExpression' || og.computed || og.property?.name !== 'og') return false;
	const meta = og.object; // import.meta
	return (
		meta?.type === 'MetaProperty' && meta.meta?.name === 'import' && meta.property?.name === 'meta'
	);
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
	key?: unknown;
	value?: unknown;
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
	if (WIRE_STATIC_MEMBER.test(code)) return true;
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
	const classes = maybeClass ? exportedWireClassNamesFromBody(body) : [];
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
		// A Region-free seam, NOT the `ogygia/internal` barrel: this import lands in every module with
		// an exported class / createContext, and the barrel re-exports `Region.svelte` (→ `$app/paths` →
		// `window`). In a bundled build tree-shaking hides that, but Vite DEV serves raw ESM, so a
		// no-window realm (the Observatory compiler worker) would crash at module-eval. See internal-register.ts.
		`import { ${imports.join(', ')} } from 'ogygia/internal/register';`
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
	SCRIPT_BLOCK_G.lastIndex = 0; // shared `g` regex — the early return below leaves it mid-string
	let m: RegExpExecArray | null;
	while ((m = SCRIPT_BLOCK_G.exec(code)) !== null) {
		const attrs = m[1];
		if (MODULE_KW.test(attrs) || CONTEXT_MODULE_ATTR.test(attrs)) {
			const bodyStart = m.index + m[0].indexOf('>', 0) + 1;
			const bodyEnd = SCRIPT_BLOCK_G.lastIndex - '</script>'.length;
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
	const exported = exportedWireClassNames(mod.body, id_n.replace(SVELTE_EXT, '.svelte.ts'));
	if (exported.length === 0) return null;
	const rel = pathModule.relative(root, id_n).split('\\').join('/');
	const block = '\n' + registrationBlock(rel, exported, []) + '\n';
	return code.slice(0, mod.injectAt) + block + code.slice(mod.injectAt);
}
