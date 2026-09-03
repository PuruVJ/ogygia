/**
 * The `virtual:ogygia/*` id vocabulary — every virtual module id the compiler mints or serves, the
 * `\0`-prefix resolver, and the per-island entry-id naming. Pure string constants + naming functions,
 * no state: the shared vocabulary the driver's resolve/emit dispatch and the linker key on.
 */

export const V_RUNTIME_URL = 'virtual:ogygia/runtime-url';
export const V_MANIFEST = 'virtual:ogygia/manifest';
export const V_RUNTIME = 'virtual:ogygia-runtime';
/** Generated sticky entry — static-imports only the features selected from build marks. */
export const V_RUNTIME_ENTRY = 'virtual:ogygia/runtime-entry';
export const V_DEV_HMR = 'virtual:ogygia/dev-hmr';
export const V_DEV_HMR_URL = 'virtual:ogygia/dev-hmr-url';
// The standalone devtools dock boot for csr=true (Kit-owned) pages — the ogygia runtime never boots
// there, so the handle injects this to mount ONLY the dock (no router/region features). Empty when
// devtools is off. The `-url` sibling is what the handle imports (a served URL, like dev-hmr-url).
export const V_DEVTOOLS_BOOT = 'virtual:ogygia/devtools-boot';
export const V_DEVTOOLS_BOOT_URL = 'virtual:ogygia/devtools-boot-url';
export const V_ISLAND_DEPS = 'virtual:ogygia/island-deps';
export const V_FN_MANIFEST = 'virtual:ogygia/fn-manifest';
export const V_SECRET = 'virtual:ogygia/secret';
export const V_SIGN = 'virtual:ogygia/sign';
export const V_RATE_LIMIT = 'virtual:ogygia/rate-limit';
export const V_PROFILER_CONFIG = 'virtual:ogygia/profiler-config';
export const V_SESSION_COOKIE = 'virtual:ogygia/session-cookie';
export const V_REGION_TTL = 'virtual:ogygia/region-ttl';
export const V_ROUTER_CONFIG = 'virtual:ogygia/router-config';
/** Generated component→CSS registrations for the SERVER router — the module that makes a router
 *  page's `<style>` reach the document (see link/router-css.ts). SSR-only, imported by ogygia/router. */
export const V_ROUTER_CSS = 'virtual:ogygia/router-css';
export const V_SERVER_MANIFEST = 'virtual:ogygia/server-manifest';
export const V_REQUEST_EVENT = 'virtual:ogygia/request-event';
/** SSR-only map of csr=true route ids — lets Region degrade a csr=false layout's islands to inline
 *  when the LEAF page is csr=true (Kit hydrates the whole document). Client leg is an empty set;
 *  the client uses `kit_hydrates_page()` for the identical signal. */
export const V_ROUTE_CSR = 'virtual:ogygia/route-csr';
export const V_REGION_ENDPOINT = 'virtual:ogygia/region-endpoint';
// Reuse Kit's OWN wire protocol (transport-aware devalue arg/response codec) instead of
// reimplementing it. We deep-import Kit's internal `runtime/shared.js` by absolute path
// (bypassing the exports map) and feed it the app's universal `transport` hook.
export const V_KIT_WIRE = 'virtual:ogygia/kit-wire';
export const V_TRANSPORT = 'virtual:ogygia/transport';
/** The app's Kit `transport` hook (`ogygia.transport`), generated per-app: the codec cluster when the
 *  app crosses regions/wired-values over the wire, an empty map for a pure-island app (no dead codecs). */
export const V_KIT_TRANSPORT = 'virtual:ogygia/kit-transport';
export const V_TRANSPORTABLES = 'virtual:ogygia/transportables';
/** `ogygia({ freeze })` policy (SERVER only; client: null) — the switch for the freeze
 *  read/write path in `ogygia.handle()`. Live adapters enter via `freeze.configure()`. */
export const V_FREEZE_CONFIG = 'virtual:ogygia/freeze-config';
/** The route ids (group-stripped) whose effective `export const freeze` opt-in is true, given the
 *  config `default` — the handle gates the render-on-write store/serve path on membership. SERVER
 *  only (empty set on the client; the route list never ships to the browser). */
export const V_FREEZE_ROUTES = 'virtual:ogygia/freeze-routes';

/** Resolve a virtual id to its `\0`-prefixed resolved form (Vite/rollup convention). */
export const RESOLVED = (id: string) => '\0' + id;

/** Virtual island ENTRY module id — JS re-export of the real component (not a thin .svelte). */
export const islandVirtualId = (iid: string) => `virtual:ogygia/island/${iid}.js`;

/**
 * Region-binding module id. A `with { region: 'raw' }` import is rewritten to import this JS
 * module, whose source is leg-split by the plugin `load` hook: the SSR leg carries the server
 * signer (so `region()` can mint a capability), the client leg is metadata-only (no server
 * code crosses into the browser bundle).
 */
export const regionBindingVirtualId = (iid: string) => `virtual:ogygia/region/${iid}.js`;
