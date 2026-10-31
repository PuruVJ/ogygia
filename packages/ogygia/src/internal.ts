/**
 * Internal wrappers the compile-time transform emits into host/island modules.
 *
 * **Not a public API** — do not import from app code. Prefer authoring regions with
 * `with { wake | render | preset }` and the public exports from `ogygia`.
 *
 * One `Region` renders every placement (island / server / lake) and every held value. Server-island
 * minting is routed through the client-stubbed `virtual:ogygia/region-endpoint` virtual, so `Region`
 * lives in the main graph without leaking `$app/server`.
 *
 * @packageDocumentation
 * @internal
 */
export { default as Region } from './Region.svelte';
// The foreign-hydrate contract (fragment federation) hydrates through the PRODUCER'S
// NestedProvider — the native runtime's exact call shape, compiled by the producer's build.
export { default as NestedProvider } from './NestedProvider.svelte';
export { og_entry_hydrate, og_entry_unmount } from './entry-hydrate.ts';
export { isNested, setNested, documentIsCsrTrue } from './context.ts';

// Transportable-class registration. Generated code appended to app modules imports
// `__register_transportable` from here (a re-export barrel — tree-shaking drops the
// component exports above, so tagging a plain `.svelte.ts` state file never pulls island
// component code into its chunk).
export { __register_transportable } from './live-transport.ts';
export { __og_$, __register_fn } from './fn-transport.ts';
export { __og_store, __register_store_factory, mark_store } from './store-transport.ts';
export { __og_boundary, configure_boundary } from './boundary.ts';
// `import.meta.og.source(fn)` compiles to `__og_source('<file#export>', fn)`.
export { __og_source } from './source.ts';
export { __tag_context } from './context-bridge.ts';

// Compiler-emitted currency — never hand-authored, so they live on the INTERNAL barrel (the public
// surface carries no snake_case): `og_portable` is the rewrite target for a `{#snippet}` handed to
// an island; `og_html_region` is what `import.meta.og.code()`/`.md()` inline at build.
export { og_portable } from './region-snippet.ts';
export { og_html_region } from './region.ts';
// What content's markdown format makes of a body baked at compile time (`@ogygia/content`).
export { prebaked_region } from './region.ts';
