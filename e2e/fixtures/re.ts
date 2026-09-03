// Shared regexes for the e2e specs — ONE definition per pattern the suites keep re-deriving:
// the region tag and its attributes, the runtime/Kit bootstrap markers, Vite dev URL shapes,
// HTML entities in attribute values, playground page markers. Import the ones you need; a
// pattern that only one spec uses stays a top-level const in that spec (house law: regexes are
// hoisted, never inline). Global (`g`) patterns are for `match`/`matchAll`/`replace` — never
// `.test()` them in a loop (lastIndex).

// ── <ogygia-region> ───────────────────────────────────────────────────────────────────────
/** Any region tag (a presence probe). */
export const REGION_TAG_RE = /<ogygia-region[\s/>]/;
/** Every region opening tag — `html.match(REGION_TAG_G_RE)?.length` counts regions. */
export const REGION_TAG_G_RE = /<ogygia-region\b/g;
/** Same count without the word boundary (the older spelling several suites still use). */
export const REGION_OPEN_G_RE = /<ogygia-region/g;
/** A request URL that hits the region endpoint (the `/__ogygia__` path). */
export const ENDPOINT_PATH_RE = /\/(?:__ogygia__|__ogygia__)/;
/** Every server-island / held hole (`render="defer"`). */
export const REGION_DEFER_G_RE = /<ogygia-region\b[^>]*\brender="defer"/g;
/** Every region that carries a signed `endpoint` — capture group 1 is the endpoint. */
export const REGION_ENDPOINT_G_RE = /<ogygia-region\b[^>]*\bendpoint="([^"]+)"/g;
/** The `endpoint` attribute of one region tag — group 1. */
export const ENDPOINT_ATTR_RE = /endpoint="([^"]*)"/;
/** A signed region endpoint URL with its expiry — group 1 is `exp`. */
export const REGION_ENDPOINT_URL_RE = /__ogygia__\?id=[^"&]+&props=[^"&]+&exp=(\d+)/;
/** The signature query parameter on a capability URL. */
export const SIG_PARAM_RE = /[?&]sig=/;
/** A hoisted region stylesheet link (`<link data-ogygia-region-css>`). */
export const REGION_CSS_LINK_RE = /data-ogygia-region-css/;
/** A generated wrapper module id. */
export const WRAPPER_VIRTUAL_RE = /virtual:ogygia\/wrapper\//;

// ── runtime / Kit bootstrap ──────────────────────────────────────────────────────────────
/** The runtime bootstrap `<script data-ogygia-runtime>`. */
export const RUNTIME_SCRIPT_RE = /data-ogygia-runtime/;
/** Kit's client bootstrap assignment (`__sveltekit_<hash> = …`): a csr=true document. */
export const KIT_BOOT_RE = /__sveltekit_\w+\s*=/;
/** Any Kit bootstrap trace at all (looser than KIT_BOOT_RE). */
export const KIT_MARKER_RE = /__sveltekit/;
/** A server-island prefetch hint. */
export const PRELOAD_FETCH_RE = /rel="preload" as="fetch"/;
/** The freeze-store stamp the handle puts on a served copy. */
export const FREEZE_META_RE = /<meta name="ogygia-freeze"[^>]*>/;

// ── Vite dev URL shapes ──────────────────────────────────────────────────────────────────
export const VITE_ID_RE = /\/@id\//;
export const VITE_FS_RE = /\/@fs\//;
export const VITE_CLIENT_RE = /@vite\/client/;

// ── HTML entity forms an attribute value can carry (normalize before URL matching) ───────
export const AMP_ENTITY_G_RE = /&amp;/g;
export const AMP_NUMERIC_G_RE = /&#38;/g;

// ── remote functions ─────────────────────────────────────────────────────────────────────
/** A Kit remote-function request (`/_app/remote/…`). */
export const REMOTE_PATH_RE = /\/_app\/remote\//;
/** The reactive `query.current` readout on /data. */
export const REACTIVE_CURRENT_RE = /reactive current: \d+/;

// ── console noise to ignore ──────────────────────────────────────────────────────────────
export const FAVICON_RE = /favicon/;

// ── federation (examples/mfe) ────────────────────────────────────────────────────────────
/** The foreign page-read dev warning. */
export const FOREIGN_WARN_RE = /was read inside a mounted MFE island/;

// ── playground page markers shared by several suites ─────────────────────────────────────
export const CHROME_HEADER_RE = /data-chrome-header/;
export const BUMPER_5_RE = /data-bumper-n[^>]*>5</;
export const PORTABLE_BAR_RE = /data-portable-bar[\s\S]*?<\/footer>/;

// ── string utilities ─────────────────────────────────────────────────────────────────────
export const NON_DIGIT_G_RE = /\D/g;
export const LEADING_DOTS_RE = /^[./]+/;
/** A `1` anywhere in a counter's text (the "clicked once" probe). */
export const ONE_RE = /1/;
