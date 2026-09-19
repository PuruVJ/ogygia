// Test stub for `virtual:ogygia/region-endpoint` (real one is the client/SSR-split module the
// Vite plugin mints). Unit tests only need the graph to load; nothing signs endpoints, and no SPA
// navigation ever reports known region fingerprints.
export const makeRegionEndpoint = () => '';
export const mintServerIsland = () => '';
export const known_region_fps = (): ReadonlySet<string> => new Set();
// A real-shaped island fingerprint (16 hex, a function of entry + canonical text): tests assert on
// `data-og-fp` and on sidecar ids keyed by it. The universal lane hash stands in for the server's
// native digest (server/fingerprint.ts needs `node:crypto`, and this stub loads in the browser
// project too); the format and the determinism are what the tests read.
import { fingerprint_of } from '../../src/runtime/hash.js';
export const islandFingerprint = (entry: string, canonical: string): string =>
	fingerprint_of(entry, '', canonical);
