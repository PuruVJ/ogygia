/**
 * ISLAND FINGERPRINT (`data-og-fp`) — the server's identity for one island instance: its module
 * URL + the canonical text of its props (server/props-wire.ts), 64 bits as 16 hex chars.
 *
 * What reads it: the runtime's sidecar lookup (`id="og-props-<fp>"`), the hydration self-heal
 * copy, the reconciler's data-key on a client navigation, and the server-delta skip (the client
 * sends the fingerprints it holds back in `x-ogygia-known`). Every one of them READS the emitted
 * attribute — the client never recomputes an island's fingerprint (runtime/reconcile.ts computes
 * one only for a region that carries none) — so the server is free to hash however is cheapest
 * here, as long as two servers agree on the same input: SHA-1 through Node's native digest,
 * ~4× the speed of the pure-JS lane hash on a 130 KB props text, and identical on every instance
 * behind a load balancer.
 *
 * NOT for a hole's identity (`data-og-hole`): the client leg of a Kit-hydrated document recomputes
 * that one, so it stays on the universal `fingerprint_of` (runtime/hash.ts) on both legs.
 *
 * Server-only (`node:crypto`), reached from Region.svelte through the client-stubbed
 * `virtual:ogygia/region-endpoint` — Region computes a fingerprint only on the server.
 */
import { createHash } from 'node:crypto';

export function island_fingerprint(entry: string, canonical: string): string {
	return createHash('sha1').update(entry).update(' ').update(canonical).digest('hex').slice(0, 16);
}
