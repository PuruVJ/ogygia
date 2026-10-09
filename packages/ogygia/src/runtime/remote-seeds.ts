/**
 * Remote-seeds feature: seed the reused Kit client query cache from the server's
 * `application/ogygia-remote` side-channel (zero-flash hydration), and clear it across SPA swaps.
 *
 * A HYDRATE-phase feature (link/runtime-entry.ts): installed by the hydrate core, never the boot —
 * only `seeds.ts` (hydrate core) reads the slot, and the decoder imports the APP's transport codecs
 * (its own `src/hooks.ts`), which reach Svelte.
 */
import { slots } from './slots.js';
import { seed_query_responses } from '../shims/kit-remote/client-stub.js';
import { clear_remote_seeds, clear_remote_instances } from '../shims/kit-remote/remote-cache.js';

/** Feature entry: fill the `remoteSeeds` slot. */
export function install() {
	slots.remoteSeeds = { seed_query_responses, clear_remote_seeds, clear_remote_instances };
}
