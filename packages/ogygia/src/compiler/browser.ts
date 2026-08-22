/**
 * The BROWSER compiler surface (the Observatory, internal/notes/devtools.md Rung 1). Re-exports what a
 * browser build needs to run the REAL ogygia compiler in-browser — now the WHOLE driver, not just the
 * host transform.
 *
 * The driver (`Compiler` / `Program` / `CompileCtx`) reaches for `node:fs` / `node:path` / `node:crypto`
 * only through the injectable {@link ./host.js host} (default: Node). A browser realm installs a virtual
 * host via {@link set_host} — an in-memory filesystem over the workspace file-map + `path`-browserify +
 * a small md5/sha — and the same `resolve_id` / `emit` / `transform_module` the Vite plugin drives now
 * run against that. Pair with {@link set_parser} (the oxc WASM parser). A rolldown-browser plugin wires
 * these three hooks exactly as `vite/index.ts` does, and bundles the workspace for real.
 *
 * The few genuinely Node-only leaves (kit's install lookup via `createRequire`, the `bake()` macro's
 * module eval, the `.git()` loader's `child_process`) load inertly in the browser and are unreachable on
 * the REPL's compile path.
 */

// The host transform + the ids/parse seams (unchanged surface, kept for existing callers).
export { transformHost, transformTsRegions, wrapperVirtualId, CLIENT_BINDING_STUB } from './region/transform.js';
export { islandVirtualId } from './ids.js';
export { set_parser, type RawParse, type ParseResult } from './parse/oxc.js';

// The FULL driver — the same classes the Vite plugin instantiates. A browser consumer builds a
// `Program` + `CompileCtx`, `new Compiler(program, …)`, then drives `resolve_id` / `emit` /
// `transform_module` from a rolldown plugin's hooks.
export { Compiler, type Profiler } from './driver.js';
export { Program, strip_id, host_key, type RegisterResult } from './program.js';
export { CompileCtx, type CompileCtxInit } from './ctx.js';

// The host seam — install a virtual filesystem / path / crypto for the browser realm.
export {
	set_host,
	type CompilerHost,
	type HostFs,
	type HostPath,
	type HostCrypto,
	type HostHasher,
	type HostStats,
	type HostDirent
} from './host.js';
