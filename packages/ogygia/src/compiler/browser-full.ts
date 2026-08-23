/**
 * The FULL browser compiler surface — the whole `Compiler` / `Program` / `CompileCtx` driver, for the
 * Observatory's rolldown-browser bundling engine (internal/notes/devtools.md Rung 1/2). Separate from
 * the lean {@link ./browser.ts} entry so a caller that only needs `transformHost` doesn't pull the
 * driver's large graph.
 *
 * A browser realm installs a virtual host via {@link set_host} (an in-memory filesystem over the
 * workspace file-map + `path`-browserify + a small md5/sha) and the oxc WASM parser via
 * {@link set_parser}, then drives the same `resolve_id` / `emit` / `transform_module` the Vite plugin
 * uses (`vite/index.ts:219` is the construction reference) from a rolldown plugin's hooks.
 *
 * Node-only leaves in the graph — kit's install lookup (`createRequire`), the `bake()` macro's module
 * eval (`node:url`), the `.git()` loader (`child_process`) — load inertly in a browser build and are
 * unreachable on the REPL compile path.
 */
export { Compiler, type Profiler } from './driver.js';
export { Program, strip_id, host_key, type RegisterResult } from './program.js';
export { CompileCtx, type CompileCtxInit } from './ctx.js';
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
export { set_parser, type RawParse, type ParseResult } from './parse/oxc.js';
export {
	transformHost,
	transformTsRegions,
	wrapperVirtualId,
	CLIENT_BINDING_STUB
} from './region/transform.js';
export { islandVirtualId } from './ids.js';
// NOTE: the manifest virtual-id vocabulary (`RESOLVED` / `V_TRANSPORTABLES` / …) is NOT re-exported here.
// Vite's dep-optimizer drops a `export { X } from './ids.js'` re-export when it prebundles this entry, so
// a browser driver reads them from the source-served `ogygia/internal/compiler-ids` entry instead.
