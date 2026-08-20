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

/**
 * Options a drop-in `setContext` may carry as its third argument. Svelte's own signature is
 * two-arg, so existing code is untouched — the marker is strictly additive.
 */
export interface SetContextOptions {
	/**
	 * GRANULARITY MARKER. `false` = this key is host-native: serve it to the same-root tree
	 * (Svelte context, unchanged) but never serialize it into the island page marker. Use it
	 * for values islands never read — a DOM-ref bag, a host-only callback, a large config
	 * object — so they cost nothing on the wire.
	 *
	 * DEFAULT is `true` (bridge): the safe direction. A missing key inside an island is a
	 * broken app; an extra bridged key is just bytes. Ogygia deliberately does NOT infer this
	 * from `getContext` call-sites — import aliasing (`import { getContext as x }`), wrapper
	 * modules, and custom context layers make any scan under-inclusive, and under-inclusion
	 * is the fatal direction. You mark; ogygia never guesses.
	 */
	islands?: boolean;
}

/** The drop-in `setContext` calls this — server records for the page bridge, client is a no-op.
 *  `opts.islands === false` skips recording: the key stays native-only (never serialized). */
export function record_ctx(key: string, value: unknown, opts?: SetContextOptions): void {
	if (opts?.islands === false) return;
	recorder?.(key, value);
}

/** DOM marker the server emits (before `</body>`) and `collect_provided_context` reads. */
export const PAGE_CTX_MARKER = 'data-ogygia-provide-page';
