// A `.ts` registry, three shapes in one file:
//   - `with { wake: 'visible' }`  → a MOUNTABLE held binding (default import). Placed via
//     `<svelte:component>` like Builder's SDK does; renders the `<ogygia-region>` shell, JS on `visible`.
//   - `with { region: 'raw' }`    → a bare HELD descriptor, rendered through `region()` + `<Region>`.
//   - `import.meta.og.asRegion(Comp, { wake })` → the SAME mountable held binding, but marking a NAMED
//     barrel import — the pattern that only the macro can reach (`with { … }` is default-import only).
import TsRegWidget from './TsRegWidget.svelte' with { wake: 'visible' };
import TsRegRaw from './TsRegRaw.svelte' with { region: 'raw' };
import { Ticker } from './barrel';

const TickerRegion = import.meta.og.asRegion(Ticker, { wake: 'visible' });

export const registry: Array<{ name: string; component: unknown }> = [
	{ name: 'tsreg-widget', component: TsRegWidget },
	{ name: 'tsreg-raw', component: TsRegRaw },
	{ name: 'tsreg-asregion', component: TickerRegion }
];
