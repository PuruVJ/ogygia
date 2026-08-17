/**
 * Presence checks for the head tags the `handle()` transform injects (the router meta, the runtime
 * bootstrap, the dev-HMR script, MPA speculation rules). Each must detect a REAL element, never the
 * tag's name as TEXT.
 *
 * Why this exists as its own module: a page that DOCUMENTS one of these tags in a code block renders
 * it HTML-escaped — `` `<meta name="ogygia-router" content="plain">` `` becomes
 * `<code>&lt;meta name="ogygia-router" content="plain"></code>`. A substring check like
 * `html.includes('name="ogygia-router"')` false-matches that prose and suppresses the injection; for
 * the router marker that silently drops the whole page to full-page navigation (no marker → the
 * client router hands off to `location.href`, so no SPA and no view transition). The changelog page
 * documents exactly these tags, which is how the bug surfaced.
 *
 * The fix each predicate shares: require a literal `<meta` / `<script` — the escaped copy carries
 * `&lt;`, never a bare `<`, so it can't match. `[^>]*` is bounded to the opening tag, so a `<script>`
 * whose BODY mentions the attribute (inline JS) can't false-match either. Every pattern is a single
 * unnested `[^>]*`, so `.test()` is linear — no backtracking on any input.
 *
 * The patterns are module constants (compiled once), never rebuilt per call: these predicates run on
 * the page HTML during every SSR response transform.
 */

/** A real `<meta name="ogygia-router" …>` element — a page opting a route out of view transitions. */
const ROUTER_META_RE = /<meta\b[^>]*\bname=["']ogygia-router["']/i;
/** A real runtime bootstrap `<script … data-ogygia-runtime …>` (Region emits it on island pages). */
const RUNTIME_SCRIPT_RE = /<script\b[^>]*\bdata-ogygia-runtime\b/i;
/** A real dev-HMR `<script … data-ogygia-dev-hmr …>`. */
const DEV_HMR_SCRIPT_RE = /<script\b[^>]*\bdata-ogygia-dev-hmr\b/i;
/** A real `<script type="speculationrules" …>` (a page authoring its own MPA speculation rules). */
const SPECULATION_RULES_RE = /<script\b[^>]*\btype=["']speculationrules["']/i;

export function page_declares_router_meta(html: string): boolean {
	return ROUTER_META_RE.test(html);
}

export function page_declares_runtime_script(html: string): boolean {
	return RUNTIME_SCRIPT_RE.test(html);
}

export function page_declares_dev_hmr_script(html: string): boolean {
	return DEV_HMR_SCRIPT_RE.test(html);
}

export function page_declares_speculation_rules(html: string): boolean {
	return SPECULATION_RULES_RE.test(html);
}
