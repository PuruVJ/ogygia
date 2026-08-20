/**
 * Shared constants for streaming a load `Promise` in `$page.data` into an island on a csr=false page.
 *
 * Kit lets `load` return a Promise at any level of `data` and STREAMS its resolution to the client
 * (render the shell with `{#await}` pending, then flush `<script>` chunks that settle it). A csr=false
 * page has no hydration, so Kit's own stream is dead there — but an ISLAND has a client. We mirror
 * Kit's shape with our OWN registry: the page seed carries a DEFER MARKER for each pending promise
 * (a real pending Promise on the client), and streamed resolve `<script>`s settle them live.
 *
 * Constants only — safe to import from both the server (staging/serialization) and the client
 * (registry/reviver), with no code crossing the boundary.
 */

/** devalue reducer/reviver name for a deferred-promise leaf in the page seed. The encoded payload is
 *  the promise's integer id (assigned in walk order). */
export const PAGE_DEFER_KEY = 'OgygiaDefer';

/** devalue reducer/reviver name for an already-SETTLED promise leaf — used on the non-navigate
 *  (SPA/router) path, which can't run streamed scripts, so each promise is awaited server-side and
 *  revived as a resolved/rejected Promise at parse time. Keeps `page.data.x` a Promise on BOTH paths
 *  (matches Kit) and lets a rejection show `{#await …:catch}` without ever crashing the render. */
export const PAGE_SETTLED_KEY = 'OgygiaSettled';

/** Global the streamed resolve `<script>`s call: `__ogygia_page_resolve(id, ok, encoded)` where
 *  `encoded` is the devalue-stringified resolved value (or the error). Installed by an inline
 *  bootstrap in the first body chunk so it exists BEFORE any resolve script runs. */
export const PAGE_DEFER_GLOBAL = '__ogygia_page_resolve';

/** One registry per document, shared by the inline bootstrap and the runtime reviver via globalThis
 *  (dev serves the runtime twice; a Symbol.for handle stays one instance — PAGE-STATE-SINGLETON). */
export const PAGE_DEFER_REGISTRY_KEY = Symbol.for('ogygia.page-defer');

/** Inline bootstrap the handle emits in the body (before the resolve scripts, which stream after
 *  `</body>`): defines the resolve global, queuing calls into the shared registry until the runtime
 *  installs the live parser. Emitted as a classic `<script>` so it runs during parse, before any
 *  streamed resolve script. Kept in sync with the runtime's `install_page_defer` registry shape. */
export const PAGE_DEFER_BOOTSTRAP =
	`(function(){var K=Symbol.for('ogygia.page-defer'),r=globalThis[K]||(globalThis[K]={});r.q=r.q||[];` +
	`globalThis.${PAGE_DEFER_GLOBAL}=function(i,o,e){if(r.live)r.live(i,o,e);else r.q.push([i,o,e]);};})();`;
