import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const _require = createRequire(import.meta.url);
// Absolute paths — the importer is ogygia inside node_modules, so a RELATIVE `this.resolve` would
// look there, not in the app. Resolve the shims off THIS file / the app's deps instead.
const CRYPTO_SHIM = fileURLToPath(new URL('./observatory-crypto-shim.ts', import.meta.url));
const PATH_BROWSERIFY = _require.resolve('path-browserify');

/**
 * Browser shims for the Node builtins the ogygia transform reaches for, so the Observatory worker can
 * run the REAL `transformHost` in-browser. Scoped to NON-SSR builds only (`opts.ssr === false`) — the
 * SSR/server build keeps the real `node:crypto` / `node:fs` / `node:path`, so nothing else regresses.
 *
 *   node:crypto → crypto-browserify  (createHash('md5') for region ids — same digest as the build)
 *   node:path   → path-browserify    (fouc-css uses `path` as a value)
 *   node:fs     → an inert stub       (fouc-css imports fs at module-load but never calls it on the
 *                                      transform path; the stub just lets the import resolve)
 */
const FS_STUB = '\0observatory:fs-stub';
const MODULE_STUB = '\0observatory:module-stub';
const EMPTY_STUB = '\0observatory:empty-stub';
// node builtins that ONLY the transform graph needs and we shim precisely; anything else node:* that
// leaks into the client (e.g. from a dep's dead branch) gets an inert empty module so it never throws.
const KNOWN_EMPTY = new Set(['node:child_process', 'node:os', 'node:worker_threads', 'node:tty', 'node:util']);

export function observatoryNodeShims(): Plugin {
	return {
		name: 'observatory-node-shims',
		enforce: 'pre',
		async resolveId(source, importer, opts) {
			// SSR keeps real node builtins.
			if (opts?.ssr) return null;
			if (source === 'node:crypto' || source === 'crypto') {
				// A tiny self-contained md5 (region ids) — NOT crypto-browserify, which drags in
				// createRequire / node:child_process and can't run in a worker.
				return CRYPTO_SHIM;
			}
			if (source === 'node:path' || source === 'path') {
				return PATH_BROWSERIFY;
			}
			if (source === 'node:fs' || source === 'fs') {
				return FS_STUB;
			}
			if (source === 'node:module') return MODULE_STUB;
			if (KNOWN_EMPTY.has(source)) return EMPTY_STUB;
			return null;
		},
		load(id) {
			if (id === MODULE_STUB) {
				// createRequire → an INERT require (returns {}). The node WASI worker (wasi-worker.mjs) is
				// dead code in the browser — the active worker is wasi-worker-browser.mjs — but its
				// top-level `require(...)` still evaluates when bundled, so it must not throw.
				return `export function createRequire() { const r = () => ({}); r.resolve = (x) => x; r.cache = {}; return r; }
export default { createRequire };`;
			}
			if (id === EMPTY_STUB) {
				return `export default {};`;
			}
			if (id === FS_STUB) {
				// Default + named exports; every method throws/no-ops (never hit on the transform path).
				return `
const unavailable = () => { throw new Error('[observatory] node:fs is not available in the browser'); };
export const readFileSync = () => null;
export const existsSync = () => false;
export const readdirSync = () => [];
export const statSync = unavailable;
export const writeFileSync = unavailable;
export const mkdirSync = unavailable;
export const rmSync = () => {};
export default { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync };
`;
			}
			return null;
		}
	};
}
