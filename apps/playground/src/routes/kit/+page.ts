// Opt into full Kit hydration for this route (overrides the root layout's csr=false).
// This is an OPTIONAL coexistence demo — islands are not required to use csr=false.
export const csr = true;

// Page data for the SharedData split-brain fixture: on this Kit-booted page the shared
// component must read Kit's REAL page data (the island shim is never seeded here).
export function load() {
	// `name`: read by the `$boot/read-page` helper this page shares with an island (e2e/shared-page-module)
	return { sharedWord: 'KitWorld', name: 'Kit' };
}
