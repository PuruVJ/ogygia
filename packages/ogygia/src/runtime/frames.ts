/**
 * frames feature: hand the client frame store to core through the {@link ./slots.js slots} seam.
 *
 * Core drives deferred / live / SWR-lake regions off this store (subscribe → apply, ensure →
 * single-flight fetch, abandon → cleanup), and the router single-flights a route's deferred holes through
 * `stream` — but NEITHER may statically import the store, or the ~10 kB store + nav-stream graph
 * lands in every build, including a plain router app with no such region. The generated runtime entry
 * installs this feature only when the app actually ships a deferred / live / lake region, so a
 * static-islands app (and a router app without deferred regions) tree-shakes the whole graph away.
 */
import { slots } from './slots.js';
import { subscribe, ensure, abandon } from './frame-store.js';
import { streamFrames } from './frame-nav.js';

export function install() {
	slots.frames = { subscribe, ensure, abandon, stream: streamFrames };
}
