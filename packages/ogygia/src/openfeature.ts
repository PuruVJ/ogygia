/**
 * `ogygia/openfeature` — the OpenFeature interop surface for ogygia flags. Two adapters, both
 * pure structural typing (no vendor SDK dependency): `openfeature(client)` bridges any
 * OpenFeature server client, `ofrep({ url })` speaks the remote-evaluation protocol directly.
 * Hand either to `decide({ source })`.
 */
export { openfeature } from './flags/openfeature.js';
export type {
	OpenFeatureClientLike,
	EvaluationContextLike,
	OpenFeatureOptions
} from './flags/openfeature.js';
export { ofrep } from './flags/ofrep.js';
export type { OfrepOptions } from './flags/ofrep.js';
