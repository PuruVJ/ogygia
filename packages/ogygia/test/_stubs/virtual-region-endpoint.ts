// Test stub for `virtual:ogygia/region-endpoint` (real one is the client/SSR-split module the
// Vite plugin mints). Unit tests only need the graph to load; nothing signs endpoints, and no SPA
// navigation ever reports known region fingerprints.
export const makeRegionEndpoint = () => '';
export const mintServerIsland = () => '';
export const known_region_fps = (): ReadonlySet<string> => new Set();
