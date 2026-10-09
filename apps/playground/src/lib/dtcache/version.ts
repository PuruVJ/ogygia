// The build's version for the cache check (internal/bench/cache-bust-check.mjs rewrites it between
// two builds). Two islands import it, so it lands in a chunk they share: a change here moves only
// that chunk, and each island's entry must still get a new name.
export const VERSION = 'v1';
