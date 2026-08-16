/**
 * Public runtime components for ogygia apps.
 *
 * Regions are authored with an import attribute on a Svelte component import:
 *
 * ```svelte
 * <script>
 *   import Counter from '$lib/Counter.svelte' with { wake: 'load' };
 *   import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
 *   import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
 * </script>
 * ```
 *
 * Configure the Vite plugin from `ogygia/vite` (`ogygia()`). Wire the signed
 * region endpoint with `ogygiaHandle()` from `ogygia/hooks`. For SPA navigation
 * from inside islands, prefer `ogygia/app` over `$app/navigation`.
 *
 * @packageDocumentation
 */
// Namespace-friendly names: `import * as ogygia from 'ogygia'` → `<ogygia.Region />`,
// `ogygia.region()`, `ogygia.transport`. The SPA router is global (opt out with
// `ogygia({ router: false })`), so there is no `<Router/>` component to render.
export { default as Boundary } from './OgygiaBoundary.svelte';

// Regions held as values — server-chosen renders you place like data. `region()` mints, `<Region>` renders.
export { default as Region } from './Region.svelte';
export { region, isRegion } from './region.js';
// Warm a deferred/live region's frame now, before its binder wakes — the "fetch now, activate later" escape hatch.
export { preload } from './preload.js';

// Serialize a self-contained function into a blocking inline `<script>` string — a theme setter (no
// dark-mode flash), a deferred font, an early flag. `{@html script(fn)}`, put the tag where you like.
export { script } from './script.js';
export { preference } from './preference.js';
export type { Preference, PreferenceSpec } from './preference.js';

// Builder.io-style pages: the blessed path is the `blocks()` content source (see `ogygia/content`).
// For a tree in hand without a collection, `blocks.resolve(tree, registry)` turns it into region nodes
// you render with a small recomposer — a recipe, not a shipped component.
export type {
	RegionValue,
	AwaitableRegion,
	InlineRegion,
	DualRegion,
	DeferredRegion,
	RegionOptions,
	RegionSchedule
} from './region.js';

// A deferred / server island renders its own HTML on the server; while it's in flight the call site
// may pass a reserved `{#snippet ogygiaFallback()}` to show meanwhile. Declare the island
// component's props with this so `svelte-check` accepts that snippet at the call site:
//   `let { …realProps }: Fallback<{ …realProps }> = $props();`
// The compiler consumes the snippet (the island component never receives it) — this is purely the
// type that teaches the checker the reserved slot exists. `svelte-check` type-checks raw component
// source (it does not run preprocessors for its type pass), so the fallback slot must be declared
// here, on the component, and cannot be injected by tooling.
export type Fallback<P = unknown> = P & { ogygiaFallback?: import('svelte').Snippet };
export { ogygiaTransport as transport } from './transport.js';

// Transportable state — a class crosses island boundaries as a prop by declaring
// `static wire = import.meta.og.wire({ encode, decode })`. Same instance across islands stays one
// live object (identity memo); the server decodes per-request so nothing leaks. The wire mark is a
// compile construct (the plugin consumes the member and mints the symbol key), so there is no
// runtime `wire` export to import — only the codec TYPE crosses into user code.
export type { TransportCodec } from './live-transport.js';

// Portable snippets — the compiler rewrites a `{#snippet}` handed to a component into

// Cross-island context — `createContext()` (typed, no string key) + `<Context of={ctx} value={v}>`.
// Bridges the DOM so a provider's value reaches islands in separate hydration roots below it.
export { createContext, __tag_context } from './context-bridge.js';
export { default as Context } from './Context.svelte';

// Which schedule woke this hydration root ('interaction' islands replay their first click, which
// is not a trusted gesture — components can adapt). Call during setup, like getContext.
export { hydratedBy } from './hydration-info.js';
