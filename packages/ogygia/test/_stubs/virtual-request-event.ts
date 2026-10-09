// Test stub for `virtual:ogygia/request-event` (real one resolves to `$app/server` on SSR and a
// throwing stub on the client). Unit tests never render inside a Kit request by default; a suite that
// needs one (a csr=true document — `documentIsCsrTrue()` reads the request's route id) installs its
// own reader with `set_request_event_stub` and clears it after.
const unavailable = () => {
	throw new Error('[ogygia] getRequestEvent is unavailable in unit tests');
};

export let getRequestEvent: () => unknown = unavailable;

/** Install (or with `null` clear) the request-event reader the library sees. */
export function set_request_event_stub(fn: (() => unknown) | null): void {
	getRequestEvent = fn ?? unavailable;
}
