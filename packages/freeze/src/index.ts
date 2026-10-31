/**
 * `@ogygia/freeze` — frozen pages (render-on-write). SERVER ONLY.
 *
 * ```ts
 * // vite.config: the switch (+ serializable policy)
 * import { freeze } from '@ogygia/freeze/vite';
 * ogygia({ plugins: [freeze()] })
 *
 * // hooks.server.ts: live objects, only for tier 2/3
 * import { freeze, valkey, upstash, akamai, cloudfront } from '@ogygia/freeze';
 * freeze.configure({ store: valkey(client), edge: [akamai(creds), cloudfront(cfg)] });
 *
 * // anywhere server-side (CMS publish webhook):
 * await freeze.invalidate('/fr/fr/solar/');            // exact URL
 * await freeze.invalidate(loadContent, [args]);        // og.source reverse index
 * await freeze.invalidateWhere({ prefix: '/fr/fr/' }); // subtree nuke
 * ```
 */
import { configure, invalidate, invalidateWhere } from './registry.ts';

export const freeze: {
	configure: typeof configure;
	invalidate: typeof invalidate;
	invalidateWhere: typeof invalidateWhere;
} = { configure, invalidate, invalidateWhere };

export { memory_store as memoryStore } from './memory-store.ts';
export { valkey } from './adapters/valkey.ts';
export { upstash } from './adapters/upstash.ts';
export { cloudflareKv } from './adapters/cloudflare-kv.ts';
export { akamai } from './adapters/akamai.ts';
export { cloudfront as awsCloudfront } from './adapters/cloudfront.ts';
export { cloudflare } from './adapters/cloudflare.ts';
// The historical name: AWS CloudFront under its own noun, since `cloudflare` exists beside it.
export { cloudfront } from './adapters/cloudfront.ts';
export type {
	FreezeEntry,
	FreezeStore,
	FreezePutOptions,
	FreezeMeta,
	EdgeAdapter,
	FreezeRuntimeConfig
} from './types.ts';
export type { ValkeyLike } from './adapters/valkey.ts';
export type { UpstashConfig } from './adapters/upstash.ts';
export type { KvNamespaceLike } from './adapters/cloudflare-kv.ts';
export type { AkamaiConfig } from './adapters/akamai.ts';
export type { CloudfrontConfig } from './adapters/cloudfront.ts';
export type { CloudflareConfig } from './adapters/cloudflare.ts';
