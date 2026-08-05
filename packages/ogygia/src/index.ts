// Public runtime API. Regions are authored with an import attribute:
//   import Comp from './Comp.svelte' with { hydrate: 'visible' };
// Public components: opt-in SPA router + optional annotation boundary (noop passthrough).
export { default as OgygiaRouter } from './OgygiaRouter.svelte';
export { default as OgygiaBoundary } from './OgygiaBoundary.svelte';
