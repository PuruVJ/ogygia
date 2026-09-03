/**
 * `ogygia/freeze` — frozen pages (render-on-write). SERVER ONLY.
 *
 * ```ts
 * // vite.config: the switch (+ serializable policy)
 * ogygia({ freeze: true })
 *
 * // hooks.server.ts: live objects, only for tier 2/3
 * import { freeze, valkey, upstash, akamai, cloudfront, cloudfrontAdapter } from 'ogygia/freeze';
 * freeze.configure({ store: valkey(client), edge: [akamai(creds), cloudfront(cfg)] });
 *
 * // anywhere server-side (CMS publish webhook):
 * await freeze.invalidate('/fr/fr/solar/');            // exact URL
 * await freeze.invalidate(loadContent, [args]);        // og.source reverse index
 * await freeze.invalidateWhere({ prefix: '/fr/fr/' }); // subtree nuke
 * ```
 */
import { configure, invalidate, invalidateWhere } from './registry.js';

export const freeze = { configure, invalidate, invalidateWhere };

export { memory_store as memoryStore } from './memory-store.js';
export { valkey } from './adapters/valkey.js';
export { upstash } from './adapters/upstash.js';
export { cloudflareKv } from './adapters/cloudflare-kv.js';
export { akamai } from './adapters/akamai.js';
export { cloudfront as awsCloudfront } from './adapters/cloudfront.js';
export { cloudflare } from './adapters/cloudflare.js';
// The historical name: AWS CloudFront under its own noun, since `cloudflare` exists beside it.
export { cloudfront } from './adapters/cloudfront.js';
export type {
	FreezeEntry,
	FreezeStore,
	FreezePutOptions,
	FreezeMeta,
	EdgeAdapter,
	FreezeRuntimeConfig
} from './types.js';
export type { ValkeyLike } from './adapters/valkey.js';
export type { UpstashConfig } from './adapters/upstash.js';
export type { KvNamespaceLike } from './adapters/cloudflare-kv.js';
export type { AkamaiConfig } from './adapters/akamai.js';
export type { CloudfrontConfig } from './adapters/cloudfront.js';
export type { CloudflareConfig } from './adapters/cloudflare.js';
