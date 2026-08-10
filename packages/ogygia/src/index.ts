/**
 * Public runtime components for ogygia apps.
 *
 * Regions are authored with an import attribute on a Svelte component import:
 *
 * ```svelte
 * <script>
 *   import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
 *   import Chart from '$lib/Chart.svelte' with { hydrate: 'visible' };
 *   import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
 * </script>
 * ```
 *
 * Configure the Vite plugin from `ogygia/vite` (`ogygia()`). Wire the signed
 * region endpoint with `ogygiaHandle()` from `ogygia/hooks`. For SPA navigation
 * from inside islands, prefer `ogygia/app` over `$app/navigation`.
 *
 * @packageDocumentation
 */
// Namespace-friendly names: `import * as ogygia from 'ogygia'` → `<ogygia.Router />`,
// `<ogygia.Region />`, `ogygia.region()`, `ogygia.transport`.
export { default as Router } from './OgygiaRouter.svelte';
export { default as Boundary } from './OgygiaBoundary.svelte';

// Regions held as values — server-chosen renders you place like data. `region()` mints, `<Region>` renders.
export { default as Region } from './Region.svelte';
export { region, isRegion } from './region.js';

// Blocks — the render half of a visual/JSON page builder. A tree of `type`d nodes → registered
// islands, only the referenced block types load. Pairs with the `blocks()` content format.
export { default as Blocks } from './Blocks.svelte';
export type {
	RegionValue,
	AwaitableRegion,
	InlineRegion,
	DualRegion,
	DeferredRegion,
	RegionOptions,
	RegionSchedule
} from './region.js';
export { ogygiaTransport as transport } from './transport.js';

// Transportable state — a class crosses island boundaries as a prop by declaring
// `static [ogygia.wire] = { encode, decode }`. Same instance across islands stays one live
// object (identity memo); the server decodes per-request so nothing leaks. See live-transport.ts.
export { wire } from './live-transport.js';
export type { TransportCodec } from './live-transport.js';

// Cross-island context — `createContext()` (typed, no string key) + `<Context of={ctx} value={v}>`.
// Bridges the DOM so a provider's value reaches islands in separate hydration roots below it.
export { createContext, __tag_context } from './context-bridge.js';
export { default as Context } from './Context.svelte';

// Which schedule woke this hydration root ('interaction' islands replay their first click, which
// is not a trusted gesture — components can adapt). Call during setup, like getContext.
export { hydratedBy } from './hydration-info.js';
