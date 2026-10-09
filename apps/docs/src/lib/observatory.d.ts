// Ambient declarations for the Observatory's in-browser compiler + REPL internals.
// (A script-scope .d.ts: no top-level import/export, so `declare module` / `declare var` are ambient.)
//
// - `svelte/internal/*` are private entrypoints without shipped types; the Observatory loads them
//   deliberately (the linker feeds compiled modules `svelte/internal/client|server`).
// - `path-browserify` ships no types; the worker uses it as the transform's `pathModule` shim.
// - the `__OBS_*` globals bridge the main thread and the injected preview islands (islands mode) and
//   the deferred-endpoint fetch intercept (server islands); declared as globals so both
//   `window.__OBS_*` and `globalThis.__OBS_*` type-check.

declare module 'svelte/internal/client';
declare module 'svelte/internal/server';
declare module 'path-browserify';

/** Linked client components the injected `<ogygia-region>` blob entries re-export (islands mode). */
declare var __OBS_ISLANDS__: Record<string, unknown> | undefined;
/** Server-island HTML per endpoint id, served by the scoped `/__obs_defer/*` fetch intercept. */
declare var __OBS_DEFER__: Record<string, string> | undefined;
/** True once the deferred-endpoint fetch intercept is installed (install-once guard). */
declare var __OBS_FETCH_PATCHED__: boolean | undefined;
