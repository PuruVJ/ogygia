import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const _require = createRequire(import.meta.url);
// Absolute paths — the importer is ogygia inside node_modules, so a RELATIVE `this.resolve` would
// look there, not in the app. Resolve the shims off THIS file / the app's deps instead.
const CRYPTO_SHIM = fileURLToPath(new URL('./observatory-crypto-shim.ts', import.meta.url));
// A LOCAL ESM wrapper (not path-browserify's raw CJS file): the raw file has no `default` export in
// dev (Vite serves it un-interop'd → "no export named 'default'"); the wrapper's bare import IS
// optimized, so default + named members resolve in both dev and build. See the shim file's header.
const PATH_SHIM = fileURLToPath(new URL('./observatory-path-shim.ts', import.meta.url));

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
const URL_STUB = '\0observatory:url-stub';
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
				return PATH_SHIM;
			}
			if (source === 'node:fs' || source === 'fs') {
				return FS_STUB;
			}
			if (source === 'node:module') return MODULE_STUB;
			// node:url — the full compiler graph (bake macro) statically imports pathToFileURL; it's only
			// reachable on the Node-only bake path (never in the REPL), so an inert impl is enough.
			if (source === 'node:url') return URL_STUB;
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
			if (id === URL_STUB) {
				// pathToFileURL/fileURLToPath — inert (bake's module eval is Node-only, never run here).
				return `export const pathToFileURL = (p) => ({ href: 'file://' + String(p) });
export const fileURLToPath = (u) => String(u).replace(/^file:\\/\\//, '');
export default { pathToFileURL, fileURLToPath };`;
			}
			if (id === EMPTY_STUB) {
				// Inert NAMED exports for the node:worker_threads / util / tty / child_process / os symbols
				// that @rolldown/browser (the in-worker compiler) statically imports. The browser build
				// never runs these paths, but rolldown's bundler still resolves the named imports and errors
				// on a missing export — so every name it reaches for must exist, even as a no-op.
				return `
export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;
export class Worker {}
export class MessageChannel {}
export class MessagePort {}
export const formatWithOptions = (_o, ...a) => a.map(String).join(' ');
export const format = (...a) => a.map(String).join(' ');
export const styleText = (_s, t) => String(t);
export const inspect = (v) => String(v);
export const promisify = (fn) => fn;
export const inherits = () => {};
export const deprecate = (fn) => fn;
export class WriteStream {}
export class ReadStream {}
export const isatty = () => false;
export const spawn = () => { throw new Error('[observatory] child_process is unavailable in the browser'); };
export const spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
export const exec = () => {};
export const execSync = () => '';
export const platform = () => 'browser';
export const arch = () => 'wasm';
export const homedir = () => '/';
export const tmpdir = () => '/tmp';
export const cpus = () => [];
export const EOL = '\\n';
export default {};
`;
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
