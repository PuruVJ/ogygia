/**
 * The LEAN browser compiler surface (the Observatory's analyze worker). Re-exports only the host
 * transform + the ids/parse/host seams — deliberately NOT the full driver, so importing this doesn't
 * drag `Compiler` / `Program` / `CompileCtx` (and their large graph) into a caller that only needs the
 * per-file transform. The FULL driver — for the rolldown-browser bundling engine — lives in the
 * separate {@link ./browser-full.ts} entry (`ogygia/internal/compiler-browser-full`).
 *
 * These modules reach `node:fs` / `node:path` / `node:crypto` only through the injectable
 * {@link ./host.js host} (default: Node); a browser realm installs a virtual host via `set_host`.
 */
export { transformHost, transformTsRegions, wrapperVirtualId, CLIENT_BINDING_STUB } from './region/transform.js';
export { islandVirtualId } from './ids.js';
export { set_parser, type RawParse, type ParseResult } from './parse/oxc.js';
export { set_host, type CompilerHost } from './host.js';
// The same dedent the `import.meta.og.code` macro uses — pure, browser-safe. The Observatory uses it so
// preset sources can sit naturally-indented in the source file (the common indent is stripped at load).
export { dedent } from './macros/dedent.js';
// The browser-safe module-macro pass (`import.meta.og.wire` + `.code`/`.md`) — the same passes a real
// build runs, so the REPL rewrites macros exactly as the compiler does (minus the node-only `bake`).
export { run_browser_macros } from './macros/browser.js';
