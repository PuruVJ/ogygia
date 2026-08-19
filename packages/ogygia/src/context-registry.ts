/**
 * Server-side capture for ogygia's drop-in `setContext` (see `./set-context.ts`). A layout that calls
 * `setContext('key', value)` (import swapped from `svelte` to `ogygia`) records the value HERE during
 * SSR; the server handle reads the per-request bag and emits ONE page-level `<script
 * data-ogygia-provide-page>` marker, which every island seeds its own `getContext('key')` from at
 * hydrate. That's how a plain `setContext` in a csr=false layout reaches child islands (separate
 * hydration roots) without a `<Provide>` in the template.
 *
 * Universal-safe by design: the recorder is a slot the SERVER installs (backed by an
 * `AsyncLocalStorage` in `hooks.ts`), so `node:async_hooks` never enters the client bundle — on the
 * client `record_ctx` is a no-op.
 */
type Recorder = (key: string, value: unknown) => void;

let recorder: Recorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped recorder. */
export function set_ctx_recorder(fn: Recorder | null): void {
	recorder = fn;
}

/** The drop-in `setContext` calls this — server records for the page bridge, client is a no-op. */
export function record_ctx(key: string, value: unknown): void {
	recorder?.(key, value);
}

/** DOM marker the server emits (before `</body>`) and `collect_provided_context` reads. */
export const PAGE_CTX_MARKER = 'data-ogygia-provide-page';
