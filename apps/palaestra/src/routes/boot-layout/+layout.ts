// Fake layout data, including a STREAMED promise (like x.svelte's data.accessibilityContent). Kit's
// own data pipe handles the promise; the shell awaits it server-side. Only plain fields cross into
// the island.
export const load = async () => {
	return {
		rtl: false,
		appName: 'boot-demo',
		// AWAITED in load → a plain value by SSR time. Renders on csr=false, and could even cross into
		// an island as a prop (it is no longer a promise).
		greetingAwaited: await new Promise<string>((res) => setTimeout(() => res('awaited-hi'), 40)),
		// RETURNED unresolved (streamed) → Kit needs client JS to swap in the resolved chunk. On
		// csr=false there is no client swap, so this never renders.
		slowGreeting: new Promise<string>((res) => setTimeout(() => res('streamed-hi'), 40))
	};
};
