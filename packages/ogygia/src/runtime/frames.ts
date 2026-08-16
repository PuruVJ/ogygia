/**
 * frames feature: hand the client frame store to core through the {@link ./slots.js slots} seam.
 *
 * Core drives deferred / live / SWR-lake regions off this store (subscribe → apply, ensure →
 * single-flight fetch, abandon → cleanup), but it must NOT statically import the store — that would
 * pull ~4.5 kB into every build, including plain load-hydrated apps that have no such region. The
 * generated runtime entry installs this feature only when the app actually ships a deferred / live /
 * lake region, so a static-islands app tree-shakes the store away entirely.
 */
import { slots } from './slots.js';
import { subscribe, ensure, abandon } from './frame-store.js';

export function install() {
	slots.frames = { subscribe, ensure, abandon };
}
