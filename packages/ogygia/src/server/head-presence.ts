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

// Hoisted (they run on every SSR head transform). All single bounded `[^>]*`/attr runs — linear, no
// backtracking; a documented (HTML-escaped) tag carries `&lt;`, never a literal `<link`, so prose
// in a code block can't match (same law as the predicates above).
const LINK_TAG_RE = /<link\b[^>]*>/g;
const LINK_REL_RE = /\brel=["']([^"']*)["']/;
const LINK_HREF_RE = /\bhref=["']([^"']*)["']/;

/**
 * Drop duplicate `<link>` tags in the HEAD — one pass over the head slice, two families:
 *
 *  - `rel="stylesheet"`: same href → first occurrence wins. Kit links a route's client-graph CSS
 *    and Region.svelte links a rendered island's CSS from the render pass; a layout island compiled
 *    as a real wrapper (a csr=true-capable layout host) is in both, so its sheet was linked twice —
 *    two render-blocking fetches of one asset. `<style>` tags are untouched.
 *  - `rel="modulepreload"`: same href → first occurrence wins. Each island's SSR emits its own
 *    dep-hint block, so islands sharing dep chunks — or one island rendered N times — repeat
 *    identical hints (a real page carried ~44 duplicate tags). Every hint ogygia emits is
 *    `fetchpriority="low"` (Region.svelte), so there is no priority to arbitrate between copies.
 *
 * Every other `<link>` passes through byte-identical. The handle calls this on the HEAD SLICE of
 * the document only (everything before `</head>`, tens of KB): the hints and the sheets live there,
 * so the 2.6 MB body is never scanned for them.
 */
export function dedupe_head_links(head: string): string {
	if (!head.includes('<link')) return head;
	const sheets = new Set<string>();
	const hints = new Set<string>();
	return head.replace(LINK_TAG_RE, (tag) => {
		const rel = LINK_REL_RE.exec(tag)?.[1];
		const seen = rel === 'stylesheet' ? sheets : rel === 'modulepreload' ? hints : null;
		if (seen === null) return tag;
		const href = LINK_HREF_RE.exec(tag)?.[1];
		if (href === undefined) return tag;
		if (seen.has(href)) return '';
		seen.add(href);
		return tag;
	});
}

// The whole runtime bootstrap element (tag + empty body), the `<head …>` open tag, and a charset
// declaration sitting first in the head. Same law as the predicates above: a literal `<script` /
// `<head` / `<meta`, one bounded `[^>]*` each, linear.
const RUNTIME_SCRIPT_ELEMENT_RE = /<script\b[^>]*\bdata-ogygia-runtime\b[^>]*><\/script>/i;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const LEADING_CHARSET_META_RE = /^\s*<meta\b[^>]*\bcharset\b[^>]*>/i;

/**
 * Put the runtime bootstrap FIRST in `<head>`: before every script the app's template and the
 * page carry. `runtime` is the tag to place when the head has none yet (`null` = only reorder what
 * is there; the tag an island page emits sits wherever Kit's head slot is, after the app's own
 * scripts in `app.html`). Returns `head` itself when there is nothing to move.
 *
 * Why the position matters: module and deferred scripts run in document order once parsing ends,
 * and the runtime's custom-element definition is what makes every `<ogygia-region>` connect and
 * keep its server markup — the copy an island hydrates against when something edited it while it
 * slept (runtime/core.ts `#ssr_html`). A design-system runtime loaded from the app template ran
 * BEFORE the runtime on a customer page and stripped the whitespace nodes of every island in the
 * header before the runtime ever saw them, so the "server copy" was the edited DOM and the login
 * island still re-rendered client-side on its first tap. First in `<head>`, the runtime sees the
 * document as the server sent it, whatever the app loads after it. A module script never blocks
 * parsing, so moving it up costs the page nothing; a charset declaration that leads the head stays
 * first (it must sit within the document's first 1024 bytes).
 */
export function runtime_first(head: string, runtime: string | null): string {
	const found = RUNTIME_SCRIPT_ELEMENT_RE.exec(head);
	const tag = found ? found[0] : runtime;
	if (tag === null) return head;
	const rest = found
		? head.slice(0, found.index) + head.slice(found.index + found[0].length)
		: head;
	const open = HEAD_OPEN_RE.exec(rest);
	// no `<head>` in this slice (a routeless document's inner head): the tag leads the content
	let at = open ? open.index + open[0].length : 0;
	const charset = LEADING_CHARSET_META_RE.exec(rest.slice(at));
	if (charset) at += charset[0].length;
	if (found && found.index === at) return head;
	return rest.slice(0, at) + tag + rest.slice(at);
}
