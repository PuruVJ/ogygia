/**
 * Kitchen-sink browser runtime — every BOOT-phase feature installed. The dev / no-marks entry: the
 * ogygia compiler injects `bootDev()` (see the plugin's `virtual:ogygia-runtime`); a per-app production
 * build instead emits a generated entry (see `vite/runtime-entry.ts`) that boots only the features it
 * uses. Both boot through {@link ./core.js core} in the same {@link ../vite/runtime-entry.js FEATURE_ORDER}.
 * HYDRATE-phase features (context, live, wire, remote-seeds) are never in the boot, dev included: the
 * hydrate core installs them from `virtual:ogygia/hydrate-features` (every one, in dev).
 *
 * Exposed as an explicit FUNCTION, not a top-level side effect: the compiler always calls it, so the
 * boot never depends on a bundler honouring `sideEffects` to survive tree-shaking / dep-prebundling.
 */
import { boot } from './core.js';
import * as frames from './frames.js';
import * as lakes from './lakes.js';
import * as morph from './morph.js';
import * as interaction from './interaction.js';
import * as forms from './form-continuity.js';
import * as router from './router.js';

/** Boot the kitchen-sink runtime (all boot-phase features). Idempotent via {@link ./core.js boot}. */
export function bootDev(): void {
	boot([frames.install, lakes.install, morph.install, interaction.install, forms.install, router.install]);
}
