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
import { boot } from './core.ts';
import * as frames from './frames.ts';
import * as lakes from './lakes.ts';
import * as morph from './morph.ts';
import * as interaction from './interaction.ts';
import * as forms from './form-continuity.ts';
import * as router from './router.ts';
import type { ClientPlugin } from '../plugin/client.ts';

/** Boot the kitchen-sink runtime (all boot-phase features) with the plugins' browser halves.
 *  Idempotent via {@link ./core.js boot}. */
export function bootDev(client_plugins: readonly ClientPlugin[] = []): void {
	boot(
		[
			frames.install,
			lakes.install,
			morph.install,
			interaction.install,
			forms.install,
			router.install
		],
		client_plugins
	);
}
