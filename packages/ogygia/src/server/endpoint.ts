// Default server-island endpoint path, in DECODED (literal) form. The 🏝️ island-emoji brackets
// make it clash-safe against real application routes. On the wire it rides as percent-encoded
// UTF-8 (%F0%9F%8F%9D%EF%B8%8F…); the browser / URL layer does that encoding when the runtime
// fetches or preloads it — we never hand-roll it — and the handle compares the DECODED pathname.
// Overridable via `ogygiaHandle({ endpoint })`.
export const DEFAULT_ISLANDS_ENDPOINT = '/🏝️ogygia🏝️';

/** Max b64url props blob accepted by the region handle (and refused at mint time). */
export const MAX_REGION_PROPS_LEN = 8192;
