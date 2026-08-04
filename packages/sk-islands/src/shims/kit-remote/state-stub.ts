// Plan A stub for Kit's client `state.svelte.js` (remote-functions read `page.url`,
// `navigating.current`). No router; good enough for request context.
export const page = {
	get url() {
		return typeof location !== 'undefined' ? new URL(location.href) : new URL('http://localhost/');
	}
};
export const navigating = { current: null };
