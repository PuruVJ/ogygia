// Public runtime API. Islands are authored with the import attribute:
//   import Comp from './Comp.svelte' with { island: 'visible' };
// The only public component is the opt-in SPA router.
export { default as ClientRouter } from './ClientRouter.svelte';
