/**
 * Kitchen-sink browser runtime — every feature installed. The dev / no-marks entry: the ogygia
 * compiler injects `bootDev()` (see the plugin's `virtual:ogygia-runtime`); a per-app production build
 * instead emits a generated entry (see `vite/runtime-entry.ts`) that boots only the features it uses.
 * Both boot through {@link ./core.js core} in the same {@link ../vite/runtime-entry.js FEATURE_ORDER}.
 *
 * Exposed as an explicit FUNCTION, not a top-level side effect: the compiler always calls it, so the
 * boot never depends on a bundler honouring `sideEffects` to survive tree-shaking / dep-prebundling.
 */
import { boot } from './core.js';
import * as remoteSeeds from './remote-seeds.js';
import * as wire from '../live-transport.js';
import * as lakes from './lakes.js';
import * as morph from './morph.js';
import * as live from './live.js';
import * as interaction from './interaction.js';
import * as forms from './form-continuity.js';
import * as persist from './persist.js';
import * as router from './router.js';

/** Boot the kitchen-sink runtime (all features). Idempotent via {@link ./core.js boot}. */
export function bootDev(): void {
	boot([
		remoteSeeds.install,
		wire.install,
		lakes.install,
		morph.install,
		live.install,
		interaction.install,
		forms.install,
		persist.install,
		router.install
	]);
}
