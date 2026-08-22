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
export { isNested, setNested } from './context.js';

// Transportable-class registration. Generated code appended to app modules imports
// `__register_transportable` from here (a re-export barrel — tree-shaking drops the
// component exports above, so tagging a plain `.svelte.ts` state file never pulls island
// component code into its chunk).
export { __register_transportable } from './live-transport.js';
export { __og_$, __register_fn } from './fn-transport.js';
export { __og_store, __register_store_factory, mark_store } from './store-transport.js';
export { __og_boundary, configure_boundary } from './boundary.js';
export { __tag_context } from './context-bridge.js';

// Compiler-emitted currency — never hand-authored, so they live on the INTERNAL barrel (the public
// surface carries no snake_case): `og_portable` is the rewrite target for a `{#snippet}` handed to
// an island; `og_html_region` is what `import.meta.og.code()`/`.md()` inline at build.
export { og_portable } from './region-snippet.js';
export { og_html_region } from './region.js';

// The SPA-nav reconciler + its child-morph — the router drives these on `document.body`; exposed here
// so a harness (the Observatory's in-preview navigation) can drive the SAME reconcile on ANY subtree,
// getting real keep/patch/mount/remove (a kept island's live state survives the nav). Tree-shakes out
// of any app that never imports them.
export { reconcile_body } from './runtime/reconcile.js';
export { morph_children } from './runtime/morph.js';
