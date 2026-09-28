/**
 * ENTRY IDENTITY → LOCATION, on the server. A hydrate island's entry and the runtime each have an
 * IDENTITY — the stable URL the compiler bakes (`/<appDir>/immutable/og-region.<iid>.js`, the
 * runtime's stable name) and every map keys by — and a LOCATION: the content-hashed file the build
 * emitted, the one a browser loads. A stable name served `immutable` would be kept for a year after
 * its content changed; a hashed name cannot go stale. The server bundle is built before the client
 * bundle, so the location is looked up at render time through the build handoff (`entryLocation`).
 *
 * No location (the dev server, a handoff from before hashing, an island from another app): the
 * identity itself is served — in a build, the stable-name shim that re-exports the current file.
 */
import runtime_url from 'virtual:ogygia/runtime-url';
import { entryLocation, islandDeps } from 'virtual:ogygia/island-deps';
import { runtime_bootstrap_tags } from './document-tail.js';

/** The file an entry is loaded from: its content-hashed location, else the identity itself. */
export function entry_src(identity: string): string {
	return (identity && entryLocation(identity)) || identity;
}

/**
 * The runtime bootstrap for a document: the runtime's script (its location) and a preload per chunk
 * it statically imports, so they download with it. `resolve` applies the base / assets prefix (Kit's
 * `asset()`); a routeless document passes none. Empty when no runtime is built.
 */
export function runtime_bootstrap(resolve: (url: string) => string = (url) => url): string {
	if (!runtime_url) return '';
	return runtime_bootstrap_tags(resolve(entry_src(runtime_url)), islandDeps(runtime_url).map(resolve));
}
