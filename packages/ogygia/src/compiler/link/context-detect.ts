/**
 * Detect whether a source file uses an ogygia **context provider** — `Provide`, the drop-in
 * `setContext`, or `createContext` imported from `'ogygia'`. Drives the `context` runtime mark, which
 * gates the ~4.7 kB cross-island context bridge OUT of apps that never provide context.
 *
 * WHY IMPORT-CLAUSE SCANNING IS SOUND: every entry point to the bridge is an
 * `import { … } from 'ogygia'` (or a namespace import used as `og.setContext(…)`) naming one of the
 * three. A read-only `getContext` needs no bridge, so it's deliberately NOT a trigger. Over-inclusion
 * is the safe direction — a MISSED provider silently drops context inside islands, an extra include is
 * just bytes — so the scan biases to include: any one matching file in `src/` sets the whole-app mark.
 *
 * Regexes are module-level (compiled once); `source_uses_ogygia_context` runs per file in the prescan
 * walk. The `g` regexes are stateful, so each use resets `lastIndex`. (The READER side — `getContext`
 * — instead follows the import binding through the AST, see `get_context_string_keys` below; a text
 * scan there would count an unrelated `getContext`.)
 */
import { parse_roots } from './page-keys.js';

/** Loose AST node — the parser hands ESTree-ish objects; positions/back-refs are skipped by the walk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvelteNode = Record<string, any>;

const OGYGIA_NAMED_IMPORT = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]ogygia['"]/g;
const OGYGIA_NS_IMPORT = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]ogygia['"]/;
const CTX_PROVIDER = /\b(?:Provide|setContext|createContext)\b/;
const NS_CTX_USAGE = /\b(\w+)\.(?:Provide|setContext|createContext)\b/g;

export function source_uses_ogygia_context(src: string): boolean {
	OGYGIA_NAMED_IMPORT.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OGYGIA_NAMED_IMPORT.exec(src))) if (CTX_PROVIDER.test(m[1])) return true;
	// Namespace form (`import * as og from 'ogygia'; og.setContext(…)`) — rare, still covered.
	const ns = OGYGIA_NS_IMPORT.exec(src);
	if (!ns) return false;
	NS_CTX_USAGE.lastIndex = 0;
	let u: RegExpExecArray | null;
	while ((u = NS_CTX_USAGE.exec(src))) if (u[1] === ns[1]) return true;
	return false;
}

/** Modules whose `getContext` reads the Svelte/ogygia context map (both resolve the same map — ogygia
 *  re-exports Svelte's, and the drop-in is read with the unchanged `getContext`). */
const CTX_MODULES = new Set(['svelte', 'ogygia']);
/** AST back-references / positions the walk must not descend into. */
const NODE_SKIP = new Set([
	'start',
	'end',
	'loc',
	'range',
	'parent',
	'metadata',
	'leadingComments',
	'trailingComments',
	'__parent',
	'__key'
]);

/** An import/member name node → its string name (`Identifier` or a string `Literal`). */
function name_of(n: SvelteNode | undefined): string | null {
	if (!n) return null;
	if (n.type === 'Identifier') return n.name ?? null;
	if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
	return null;
}

/** A string-literal argument's value, else null (a dynamic key is deliberately not counted). */
function literal_string(n: SvelteNode | undefined): string | null {
	return n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null;
}

/** The string-literal keys a file READS via getContext and SETS via setContext — each PROVEN, by
 *  following the import binding rather than matching text, to be Svelte/ogygia's. */
export interface ContextKeys {
	reads: string[];
	sets: string[];
}

/**
 * Resolve the string-literal keys a file reads via `getContext(…)` and sets via `setContext(…)`, where
 * each call is PROVEN — by following the import binding, not by matching text — to be Svelte's or
 * ogygia's. Counts a `getContext as gc` alias and a namespace `ns.getContext(…)`; ignores a local
 * function of the same name, a `foo.getContext(…)` on an unrelated object, and a dynamic key. ogygia's
 * own bridge keys are `Symbol.for(…)` (never string literals), so they never appear.
 *
 * `reads` drives the WARNING: on a csr=false page the page/layout `<script>` never runs on the client,
 * so a value set with Svelte's own `setContext` in a page/layout is gone by the time an island hydrates
 * in isolation — the island reads `undefined`, renders a different tree, and Svelte discards its server
 * DOM (a silent full re-render). `sets` is what makes the warning precise: a key an island's OWN code
 * both sets and reads lives inside one hydration root (a component library using context internally) and
 * needs no bridge — the caller subtracts island sets from island reads so only a key provided OUTSIDE
 * the island is flagged. Empty on a file with no such call, or one that cannot be parsed.
 */
export function context_string_keys(src: string, kind: 'svelte' | 'script'): ContextKeys {
	const wants_get = src.includes('getContext');
	const wants_set = src.includes('setContext');
	if (!wants_get && !wants_set) return { reads: [], sets: [] }; // cheap pre-filter before the parse
	const roots = parse_roots(src, 'ogygia:context-detect', kind);
	if (!roots) return { reads: [], sets: [] };

	// Local bindings resolved to Svelte/ogygia's getContext / setContext, plus namespace imports of a
	// context module (`import * as x from 'svelte'` → `x.getContext(…)`).
	const get_locals = new Set<string>();
	const set_locals = new Set<string>();
	const namespaces = new Set<string>();
	const calls: SvelteNode[] = [];
	const walk = (node: SvelteNode | null | undefined): void => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const c of node) walk(c as SvelteNode);
			return;
		}
		if (node.type === 'ImportDeclaration' && CTX_MODULES.has(String(node.source?.value ?? ''))) {
			for (const s of node.specifiers ?? []) {
				if (s.type === 'ImportSpecifier' && s.local?.name) {
					const imported = name_of(s.imported);
					if (imported === 'getContext') get_locals.add(s.local.name);
					else if (imported === 'setContext') set_locals.add(s.local.name);
				} else if (s.type === 'ImportNamespaceSpecifier' && s.local?.name) {
					namespaces.add(s.local.name);
				}
			}
		} else if (node.type === 'CallExpression') {
			calls.push(node);
		}
		for (const k in node) {
			if (NODE_SKIP.has(k)) continue;
			const v = (node as Record<string, unknown>)[k];
			if (v && typeof v === 'object') walk(v as SvelteNode);
		}
	};
	for (const root of roots) walk(root);
	if (get_locals.size === 0 && set_locals.size === 0 && namespaces.size === 0)
		return { reads: [], sets: [] };

	const reads = new Set<string>();
	const sets = new Set<string>();
	for (const call of calls) {
		const key = literal_string(call.arguments?.[0]);
		if (key == null) continue;
		const callee = call.callee;
		if (callee?.type === 'Identifier') {
			if (get_locals.has(callee.name)) reads.add(key);
			else if (set_locals.has(callee.name)) sets.add(key);
		} else if (
			callee?.type === 'MemberExpression' &&
			!callee.computed &&
			callee.object?.type === 'Identifier' &&
			namespaces.has(callee.object.name)
		) {
			const member = name_of(callee.property);
			if (member === 'getContext') reads.add(key);
			else if (member === 'setContext') sets.add(key);
		}
	}
	return { reads: [...reads], sets: [...sets] };
}
