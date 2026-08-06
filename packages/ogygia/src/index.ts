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
export { default as OgygiaRouter } from './OgygiaRouter.svelte';
export { default as OgygiaBoundary } from './OgygiaBoundary.svelte';
