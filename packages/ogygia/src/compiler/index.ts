/**
 * ogygia's compiler core — the pure source→source engine, decoupled from any build host.
 *
 * Everything here is side-effect-free: it takes source text plus a plain `ctx` bag and returns
 * `{ code, map, islands[] }`. It never calls `emitFile`, resolves virtual modules, or touches the
 * build graph — the caller (the Vite plugin, or a standalone Svelte preprocessor) owns that. That
 * is the whole point of the carve-out: the SAME rewrite must run in two places —
 *   - the Vite plugin (`ogygia/vite`), which consumes the returned `islands[]` to emit chunks, and
 *   - a standalone preprocessor, which runs under `svelte-check` / any non-Vite compile where the
 *     plugin never boots, so the marked `with { … }` imports still get rewritten and type-check.
 *
 * Anything build-specific (real chunk URLs, virtual-module ids) is expressed here only as PURE
 * naming functions (`islandPublicUrl`, `wrapperVirtualId`, …); they appear as string literals in
 * generated source and never gate type-checking, so a types-only run can pass placeholders.
 *
 * The DRIVER SPINE (`Compiler` / `Program` / `CompileCtx`) is the same carve-out one level up: a
 * long-lived, bundler-agnostic compile session (it imports no Vite) that fuses the file-local
 * front-end — `transform` (host islands), `ts_regions`, `macros`, and `prescan` (whole-app island
 * discovery) — over a `Program` (cross-file linker) and a resolved `CompileCtx`. A REPL or any
 * non-Vite host is just a second adapter: build a `CompileCtx`, `configure()` the `Compiler`, and
 * feed it source. The Vite plugin (`ogygia/vite`) is the reference adapter that drives it.
 *
 * Exposed to consumers as `ogygia/internal/compiler` (internal, not a stable public API).
 */
export * from './region/transform.js';
export * from './fouc-css.js';
export * from './free-vars.js';
export { Compiler, type Profiler } from './driver.js';
export { Program, strip_id, host_key } from './program.js';
export { CompileCtx, type CompileCtxInit } from './ctx.js';
export * from './ids.js';
