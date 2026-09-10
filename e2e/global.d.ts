// Test-only global augmentation used by the browser suites (evaluated in the page).
// `__og_e2e_stamp` is the per-document SPA-vs-reload stamp the suites set (fixtures/index.ts).
interface Window {
	__og_e2e_stamp?: number;
}
