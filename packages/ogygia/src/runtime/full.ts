/**
 * Kitchen-sink browser runtime — every feature installed. This is the safe default entry
 * (`import 'ogygia/runtime'`) when the build has no feature marks; a per-app build instead emits a
 * generated entry (see `vite/runtime-entry.ts`) that imports only the features it uses. Both boot
 * through {@link ./core.js core} in the same {@link ../vite/runtime-entry.js FEATURE_ORDER}.
 */
import { boot } from './core.js';
import * as remoteSeeds from './remote-seeds.js';
import * as wire from '../live-transport.js';
import * as stream from './stream-slots.js';
import * as lakes from './lakes.js';
import * as morph from './morph.js';
import * as live from './live.js';
import * as interaction from './interaction.js';
import * as forms from './form-continuity.js';
import * as persist from './persist.js';
import * as router from './router.js';
import * as speculate from './speculate.js';

boot([
	remoteSeeds.install,
	wire.install,
	stream.install,
	lakes.install,
	morph.install,
	live.install,
	interaction.install,
	forms.install,
	persist.install,
	router.install,
	speculate.install
]);
