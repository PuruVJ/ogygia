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
// og_derived — a derived that RESUMES across island boundaries: its recipe (sources + an
// og.$-marked formula) crosses, and islands re-derive against the reunified live sources.
export { og_derived } from './store-transport.js';
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
// `transport` is GENERATED per-app (virtual:ogygia/kit-transport): the codec cluster when the app
// crosses a region/wired value over Kit's wire, an empty map for a pure-island app — so a plain-props
// app never bundles the ~9 kB of decoders it can't use. The virtual re-exports the real `ogygiaTransport`
// from './transport.js' by absolute path; the barrel deliberately does NOT re-export it directly (that
// would be a second, ungated path to the codec cluster for `import * as ogygia`).
export { transport } from 'virtual:ogygia/kit-transport';

// Transportable state — a class crosses island boundaries as a prop by declaring
// `static wire = import.meta.og.wire({ encode, decode })`. Same instance across islands stays one
// live object (identity memo); the server decodes per-request so nothing leaks. The wire mark is a
// compile construct (the plugin consumes the member and mints the symbol key), so there is no
// runtime `wire` export to import — only the codec TYPE crosses into user code.
export type { TransportCodec } from './live-transport.js';

// Portable snippets — the compiler rewrites a `{#snippet}` handed to a component into

// Cross-island context — one bridge, plain `getContext`. `<Provide values={obj | array}>` in a
// (csr=false) layout writes serialized values into the DOM; child islands keep `getContext('key')`
// unchanged — ogygia seeds each island's context from the DOM at hydrate, so it crosses the root
// split. `createContext('key')` is optional TYPED sugar: callable to make a `<Provide>` entry,
// `.get()` to read. Values must be serializable, like island props.
//
// `setContext` is the drop-in for existing layouts: swap `from 'svelte'` → `from 'ogygia'` and a
// plain `setContext('key', value)` bridges to child islands too (one flat page root). `<Provide>` is
// the scoped/shadowed form; both are read with the same unchanged `getContext('key')`.
export { createContext, setContext, __tag_context } from './context-bridge.js';
export { default as Provide } from './Provide.svelte';
// `getContext` is re-exported verbatim from Svelte, purely for import symmetry — `import { setContext,
// getContext } from 'ogygia'` reads better than mixing sources. It is Svelte's own: ogygia seeds each
// island's context at hydrate, so a plain `getContext` already reads bridged values with no wrapper.
export { getContext } from 'svelte';

// Which schedule woke this hydration root ('interaction' islands replay their first click, which
// is not a trusted gesture — components can adapt). Call during setup, like getContext.
export { hydratedBy } from './hydration-info.js';

// EXPERIMENTAL — cross-fragment shared state (contract packages import this): `.current` like
// MediaQuery, reactive via createSubscriber, all builds meet at one Symbol.for page store.
// Server-seedable via a printed JSON script tag; vanilla door at globalThis.ogygia.shared().
export { SharedState } from './shared-state.js';

// Experiments / flags / rollouts: the ASSIGNMENT primitive (server-side, sticky, zero-JS).
// Branching rides existing primitives — a router page's `pick`, a load's data branch, a region
// choice. Environment-free on purpose (pure hash, no node builtins).
export {
	experiment,
	flag,
	layer,
	allowOverrides,
	onExposure,
	batchExposures,
	type ExposureEvent,
	type Experiment,
	type ExperimentOptions,
	type Flag,
	type FlagOptions,
	type Layer,
	type ComponentPick
} from './experiment.js';
