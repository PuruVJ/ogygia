// A `.ts` registry with BOTH region shapes, mixed in one file:
//   - `wake: 'visible'`  → a MOUNTABLE portable binding. A third-party renderer (like Builder.io's SDK)
//     PLACES it via `<svelte:component>`; it renders the `<ogygia-region>` shell and fetches its JS only
//     on the `visible` schedule. (Since the mountable-`.ts`-wake change.)
//   - `region: 'raw'`    → a bare HELD descriptor, handed to ogygia's own `region()` + `<Region>`, its
//     schedule set at the call. This shape is unchanged.
// Both `region()` still works on the wake binding too (the metadata rides on the wrapper).
import TsRegWidget from './TsRegWidget.svelte' with { wake: 'visible' };
import TsRegRaw from './TsRegRaw.svelte' with { region: 'raw' };

export const registry: Array<{ name: string; component: unknown }> = [
	{ name: 'tsreg-widget', component: TsRegWidget },
	{ name: 'tsreg-raw', component: TsRegRaw }
];
