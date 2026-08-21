/**
 * Live-region feature: the props-pushable host a live `<Region>` hydrates through, so later
 * `query.live` ticks push new props into the mounted island (keep-alive) instead of re-hydrating.
 */
import { slots } from './slots.js';
import LiveHost from '../LiveHost.svelte';

/** Feature entry: fill the `live` slot with {@link LiveHost}. */
export function install() {
	slots.live = LiveHost as unknown as NonNullable<typeof slots.live>;
}
