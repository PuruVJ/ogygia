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
 * walk. The `g` regexes are stateful, so each use resets `lastIndex`.
 */
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
