/**
 * Per-page/-layout shell-cache config: `export const shell = <config>` in a route's
 * `+page(.server).ts` or `+layout(.server).ts`. **Same API as `remount`:**
 *
 * ```ts
 * export const shell = 'cache';                        // freeze the shell
 * export const shell = 'swr';                          // serve stale, revalidate
 * export const shell = 'empty';                        // (or `false`) — don't cache
 * export const shell = { revalidate: 'load', maxAge: '5m' };   // swr, stale after 5m
 * ```
 *
 * `maxAge` is ms or a duration string (`'5m'`). `revalidate`'s schedule and `onExpire` are lake
 * concepts — a shell revalidates on the request, so for the shell `revalidate` only chooses
 * cache-vs-swr (accepted for API parity, otherwise ignored).
 *
 * Parsed with oxc (never regex — a `shell` in a string or a comment must not match, and the
 * declaration can appear anywhere). Kit rejects unknown route exports, so the build strips the
 * `export ` keyword after recording the config.
 */
import { parseSync } from 'vite';

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;

interface Literal {
	type: string;
	value?: unknown;
}
interface Property {
	type: string;
	key?: { type?: string; name?: string; value?: unknown };
	value?: Literal;
}
interface InitNode extends Literal {
	properties?: Property[];
}
interface Node {
	type: string;
	start: number;
	end: number;
	declaration?: {
		type: string;
		start: number;
		kind?: string;
		declarations?: { id?: { type: string; name?: string }; init?: InitNode }[];
	} | null;
}

/** A page/layout shell mode: cache (freeze) / swr (serve stale, revalidate) / off (never). */
export type ShellMode = 'cache' | 'swr' | 'off';

/** Resolved per-route shell policy. `off` never reaches the runtime map. */
export interface ShellPolicy {
	mode: ShellMode;
	/**
	 * Max age (ms) a cached shell stays fresh before a `swr` revalidate or a `cache` expiry.
	 * Authored as `maxAge` (a number of ms, or a duration string like `'5m'`) to match `remount`.
	 */
	maxAgeMs?: number;
}

/** `maxAge` → ms. Number (ms) or duration string (`30s` / `5m` / `1h` / `500ms`) — same as `remount`. */
function parseMaxAge(raw: unknown): number | undefined {
	if (raw == null) return undefined;
	if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
	if (typeof raw === 'string') {
		const m = raw.trim().match(DURATION);
		if (!m) return undefined;
		const unit = (m[2] || 'ms').toLowerCase();
		const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
		return Math.floor(Number(m[1]) * mult);
	}
	return undefined;
}

export interface ShellExport extends ShellPolicy {
	/** Offset of the `export` keyword (node start). */
	exportStart: number;
	/** Offset of the `const` keyword — slice out `[exportStart, declStart)` to drop `export `. */
	declStart: number;
}

/** The authorable shell config — identical to `remount`'s shape. */
export type ShellConfig =
	| 'cache'
	| 'empty'
	| 'swr'
	| false
	| { revalidate?: false | string; maxAge?: number | string; onExpire?: 'empty' | 'fetch' };

/**
 * Normalize a shell config VALUE (from `ogygia({ shell })` or a reconstructed page/layout export)
 * into `{ mode, maxAgeMs }`. Same API as `remount`. `'empty'` / `false` → `off` (not cached).
 */
export function normalizeShellPolicy(raw: unknown): ShellPolicy | null {
	if (raw === 'cache') return { mode: 'cache' };
	if (raw === 'swr') return { mode: 'swr' };
	if (raw === 'empty' || raw === false) return { mode: 'off' };
	if (raw && typeof raw === 'object') {
		const o = raw as { revalidate?: unknown; maxAge?: unknown; onExpire?: unknown };
		if (o.revalidate == null && o.maxAge == null && o.onExpire == null) return null;
		const mode: ShellMode = o.revalidate && o.revalidate !== false ? 'swr' : 'cache';
		const maxAgeMs = parseMaxAge(o.maxAge);
		return maxAgeMs === undefined ? { mode } : { mode, maxAgeMs };
	}
	return null;
}

/** Reconstruct the config VALUE from the AST init node, then normalize (shared with the global). */
function readConfig(init: InitNode): ShellPolicy | null {
	if (init.type === 'Literal') return normalizeShellPolicy(init.value);
	if (init.type === 'ObjectExpression') {
		const value: Record<string, unknown> = {};
		for (const prop of init.properties ?? []) {
			if (prop.type !== 'Property' || prop.key?.type !== 'Identifier') continue;
			if (prop.value?.type === 'Literal') value[prop.key.name!] = prop.value.value;
		}
		return normalizeShellPolicy(value);
	}
	return null;
}

/**
 * Find a top-level `export const shell = …`. Returns its resolved policy and the span of the
 * `export ` keyword to strip, or `null` when the module has no valid `shell` export.
 */
export function parseShellExport(code: string, id_n: string): ShellExport | null {
	if (!code.includes('shell')) return null;
	let body: Node[];
	try {
		const result = parseSync(id_n, code) as { program?: { body?: Node[] }; errors?: unknown[] };
		if (result.errors && result.errors.length > 0) return null;
		body = result.program?.body ?? [];
	} catch {
		return null;
	}
	for (const node of body) {
		if (node.type !== 'ExportNamedDeclaration') continue;
		const decl = node.declaration;
		if (!decl || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
		for (const d of decl.declarations ?? []) {
			if (d.id?.type !== 'Identifier' || d.id.name !== 'shell' || !d.init) continue;
			const policy = readConfig(d.init);
			if (policy) return { ...policy, exportStart: node.start, declStart: decl.start };
		}
	}
	return null;
}
