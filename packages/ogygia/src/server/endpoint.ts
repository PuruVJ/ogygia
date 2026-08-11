// Default server-island / region endpoint path, in DECODED (literal) form. The single 🏝️
// island-emoji makes it clash-safe against real application routes. On the wire it rides as
// percent-encoded UTF-8 (%F0%9F%8F%9D%EF%B8%8F); the browser / URL layer does that encoding when
// the runtime fetches or preloads it — we never hand-roll it — and the handle compares the DECODED
// pathname. Overridable via `ogygiaHandle({ endpoint })`.
export const DEFAULT_ISLANDS_ENDPOINT = '/🏝️';

/** Max b64url props blob accepted by the region handle (and refused at mint time). */
export const MAX_REGION_PROPS_LEN = 8192;

/**
 * Default capability TTL (seconds) for DYNAMIC pages. Shorter than a day so harvested URLs age
 * out; override via `ogygia({ regionTtl })`.
 */
export const DEFAULT_REGION_TTL_SEC = 3600;

/**
 * Capability TTL for PRERENDERED pages (10 years — effectively the life of the deploy). A static
 * file lives on the CDN indefinitely, so an aging capability would strand every hole on it after
 * `regionTtl` (real PPR would silently die in an hour). Safe: the capability's props are already
 * baked into the public static HTML, and the mint seals an EMPTY session at prerender — signing
 * that same public tuple for longer reveals nothing new. Redeploy survival additionally needs a
 * stable `OGYGIA_SECRET` (the default per-build key rotates; ServerIsland warns at build).
 */
export const PRERENDER_REGION_TTL_SEC = 10 * 365 * 24 * 3600;

/** Region ids are always 12 lowercase hex chars from the transform. */
export const REGION_ID_RE = /^[0-9a-f]{12}$/;

/**
 * A hole's optional cache `ttl` (max-age seconds) as it rides in the endpoint URL: empty (no-store,
 * the default) or 1–7 digits (up to ~115 days). Charset-gated before HMAC so a forged value can't
 * reach the response header, though the MAC is the real guard.
 */
export const REGION_TTL_RE = /^(|[0-9]{1,7})$/;
