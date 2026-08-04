// Test-only global augmentation used by the browser suites (evaluated in the page).
// `__marker` is the runtime's SPA-vs-reload observability marker (see runtime/index.ts).
interface Window {
	__marker?: number;
}
