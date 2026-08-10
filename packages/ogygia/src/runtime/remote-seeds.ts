/**
 * Remote-seeds feature: seed the reused Kit client query cache from the server's
 * `application/ogygia-remote` side-channel (zero-flash hydration), and clear it across SPA swaps.
 */
import { slots } from './slots.js';
import { seed_query_responses } from '../shims/kit-remote/client-stub.js';
import { clear_remote_seeds, clear_remote_instances } from '../shims/kit-remote/remote-cache.js';

/** Feature entry: fill the `remoteSeeds` slot. */
export function install() {
	slots.remoteSeeds = { seed_query_responses, clear_remote_seeds, clear_remote_instances };
}
