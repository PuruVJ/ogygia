/**
 * The LEAN compiler surface (the Observatory's analyze worker, and first-party plugins' macros in
 * node). Re-exports only the host
 * transform + the ids/parse/host seams — deliberately NOT the full driver, so importing this doesn't
 * drag `Compiler` / `Program` / `CompileCtx` (and their large graph) into a caller that only needs the
 * per-file transform. The FULL driver — for the rolldown-browser bundling engine — lives in the
 * separate {@link ./browser-full.ts} entry (`ogygia/internal/compiler-browser-full`).
 *
 * These modules reach `node:fs` / `node:path` / `node:crypto` only through the injectable
 * {@link ./host.js host} (default: Node); a browser realm installs a virtual host via `set_host`.
 */
export {
	transformHost,
	transformTsRegions,
	wrapperVirtualId,
	CLIENT_BINDING_STUB
} from './region/transform.ts';
export { islandVirtualId } from './ids.ts';
export { set_parser, parse_module, type RawParse, type ParseResult } from './parse/oxc.ts';
export { set_host, fs, path, createHash, type CompilerHost } from './host.ts';
// The building blocks of an `import.meta.og.*` macro, for first-party plugins' macros (content's
// `code` / `md` / `loader` / `regions`): the call scanner, the member matcher, and the build cache.
// Host-seamed like everything here, so they run in node (the default host) and in the Observatory.
export {
	find_og_calls,
	split_first_string,
	og_js_regions,
	is_js_module,
	type OgCall,
	type JsRegion
} from './parse/scan.ts';
export { og_member } from './macros/wire.ts';
export { BuildCache, configure_build_cache, __set_build_cache_root } from '../build-cache.ts';
// The content-CSS key the markdown preprocessor bakes and the build's CSS emit reads back.
export { content_css_key } from '../plugin/utils.ts';
// The same dedent the `import.meta.og.code` macro uses — pure, browser-safe. The Observatory uses it so
// preset sources can sit naturally-indented in the source file (the common indent is stripped at load).
export { dedent } from './macros/dedent.ts';
// The browser-safe module-macro pass (`import.meta.og.wire` + `.code`/`.md`) — the same passes a real
// build runs, so the REPL rewrites macros exactly as the compiler does (minus the node-only `bake`).
export { run_browser_macros } from './macros/browser.ts';
