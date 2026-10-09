/**
 * SERVER-realm devtools bridge — the client-safe seam between the SSR render seams (Region.svelte,
 * server/region-endpoint.ts) and the request-scoped collector in `hooks.ts`. Mirrors the
 * `set_page_recorder` / `record_page` pattern exactly (see page-seed-registry.ts):
 *
 *   - `hooks.ts` (server-only, owns the AsyncLocalStorage) installs a REQUEST-SCOPED recorder that
 *     stamps the envelope and pushes into that request's event array — so concurrent SSR requests
 *     never share a buffer (the client bus's single global ring is wrong on a long-lived server).
 *   - Region.svelte + region-endpoint.ts call {@link record_server_event} during SSR; it forwards to
 *     the installed recorder. On the client (or an isolated endpoint render with no recorder) it is a
 *     no-op — so this module is universal-safe and carries NO `node:` import.
 *
 * The collected events are drained by the handle and shipped to the browser as an
 * `application/ogygia-devtools` side-channel `<script>`, which the client bus INGESTS into the same
 * `window.__ogygia_devtools` stream — so a region's server render and its client wake sit in one
 * timeline, correlated by fingerprint.
 */
import type { DevtoolsEventInput } from './schema.js';

// DEVTOOLS gate (the SSR bundle has the `__OGYGIA_DEVTOOLS__` define; the client has it too but the
// recorder is never installed there, so `record_server_event` no-ops). Off → this whole file DCEs.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** A recorder receives the un-stamped event input; hooks.ts stamps + buffers it per request. */
export type ServerDevtoolsRecorder = (input: DevtoolsEventInput) => void;

let recorder: ServerDevtoolsRecorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped, ALS-backed recorder. Passing `null` clears it. */
export function set_server_devtools_recorder(fn: ServerDevtoolsRecorder | null): void {
	recorder = fn;
}

/** SSR render seams call this; the client (recorder unset) is a no-op, and the whole call DCEs off. */
export function record_server_event(input: DevtoolsEventInput): void {
	if (!DEVTOOLS) return;
	recorder?.(input);
}
