// Test stub for `virtual:ogygia/request-event` (real one resolves to `$app/server` on SSR and a
// throwing stub on the client). Unit tests never render inside a Kit request.
export const getRequestEvent = () => {
	throw new Error('[ogygia] getRequestEvent is unavailable in unit tests');
};
