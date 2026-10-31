/**
 * `freeze()` — frozen pages (render-on-write), for `ogygia({ plugins: [freeze()] })` in vite.config.
 * The SWITCH + serializable policy, nothing else: a page whose render observed no personalization
 * is stored whole and served as bytes until `freeze.invalidate(url)` /
 * `freeze.invalidateWhere({ prefix })` or the TTL backstop. Live adapters (a valkey client, CDN
 * purge creds) are configured in hooks.server.ts via `freeze.configure({ store, edge })` from
 * `@ogygia/freeze`.
 *
 * `default` sets the app-wide opt-in: `true` (the default) keeps the auto behaviour — every eligible
 * page is stored, observed purity refuses the rest, and a route opts OUT with
 * `export const freeze = false`. `false` flips the app to OPT-IN: nothing is stored unless a page or
 * a layout it sits under declares `export const freeze = true` (it cascades like `csr`, deepest
 * declaration wins; ogygia strips it before Kit sees it).
 */
import { definePlugin, type OgygiaPlugin } from 'ogygia/vite';
import type { FreezeServerOptions } from './server.js';

export interface FreezeOptions {
	/** TTL backstop in seconds (default 86400, clamped to [1, 86400]): nothing is stale forever. */
	ttl?: number;
	/** The app-wide opt-in (default true). */
	default?: boolean;
}

export function freeze(options: FreezeOptions = {}): OgygiaPlugin<FreezeServerOptions> {
	return definePlugin<FreezeServerOptions>({
		name: '@ogygia/freeze',
		options: {
			ttl: Math.min(86400, Math.max(1, Math.floor(options.ttl ?? 86400))),
			default: options.default ?? true
		},
		build(b) {
			b.routeOption('freeze');
		}
	});
}
