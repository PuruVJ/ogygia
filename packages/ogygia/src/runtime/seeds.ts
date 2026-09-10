/**
 * THE PAGE SEED (and the props sidecars) on the client — parsed ONCE per document, kept in ONE place.
 *
 * The handle ships `page.data` (and url/params/route/…) as `<script type="application/ogygia-page">`
 * so islands can read `$page`, and a seed REFERENCE in an island's props (`seed-refs.ts`) points into
 * that same tree. Both readers resolve here:
 *   • the LIVE document's seed is `page_state` — the `$app/state` store the shims already read. It is
 *     parsed once (`seed_page_once`, lazily on the first hydrate) and every seed reference resolves
 *     against `page_state.data` — the exact object the islands' `page.data` is, not a second parse.
 *   • a FOREIGN document (the one a navigation fetched) is parsed once per `Document` and remembered
 *     on it: a kept island absorbs the incoming page's props BEFORE the router applies that page's
 *     seed, so its references must resolve against the incoming seed, not the current one. The
 *     navigation's soft-invalidate then applies the SAME parse — never a second one.
 * A parse count of one per document is what `test/browser/seed-single-parse.test.ts` pins; the old
 * two-cache shape (a per-element cache the morph reused across pages) handed a navigated page the
 * previous page's data — the stale-reference regression that test also carries.
 *
 * WIRE FORMATS: a seed or props script carries `data-og-format="json"` when its payload is plain
 * JSON (no custom types, no seed references) — then it is `JSON.parse`d, nothing else. Without the
 * attribute it is devalue text and parses with the revivers the caller hands in. One helper
 * (`parse_sidecar_text`) is the only place that decision is made.
 *
 * After a successful parse the seed's TEXT is blanked (router on, devtools off): the graph lives in
 * `page_state` from here on and nothing reads the script again — 690 KB of text on a CMS page has
 * no second reader, and the morph carries the next page's seed in (already blank, parsed in the
 * navigation's preflight). Devtools keeps the text: its byte ledger reads it.
 */
import { parse } from 'devalue';
import { page_state, set_page, reset_page, type PageSnapshot } from '../shims/page-store.svelte.js';
import { install_page_defer, page_defer_revivers } from './page-defer.js';
import { transport_decoders } from './app-transport.js';
import { runtime_session } from './session.js';
import { slots } from './slots.js';
import { invalidate_hint_set } from './region-endpoint-url.js';
import { inside_frozen } from './region-attrs.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

export const PAGE_SEED_SELECTOR = 'script[type="application/ogygia-page"]';
const REMOTE_SEED_SELECTOR = 'script[type="application/ogygia-remote"]';

/** A seed or props script's payload: JSON lane when the server marked it plain, devalue otherwise. */
export function parse_sidecar_text(
	el: Element,
	revivers?: Record<string, (d: never) => unknown>
): unknown {
	const text = el.textContent ?? '';
	if (el.getAttribute('data-og-format') === 'json') return JSON.parse(text);
	return parse(text, revivers as Parameters<typeof parse>[1]);
}

/**
 * KEYED SIDECAR RELEASE. A keyed props sidecar (`data-og-fp` island, page pass) has exactly as many
 * readers as the page has regions with its fingerprint — identical islands share one script — and
 * each reads it once, at hydrate. Once the last reader has parsed it the text is blanked: the props
 * live in the island now, and 300 KB of sidecar text on a CMS page had no second reader. Counted
 * from ONE walk of the live document on the first release (dropped when the router prepares the
 * next document). Never blanked: an adjacent (fingerprint-less) sidecar — a hole's, a lake's, a
 * live region's — and an island INSIDE a lake, whose `{#if}` remount re-reads it from the lake
 * cache; a foreign document's sidecar (a kept island absorbing the incoming page's props — the
 * morph carries that script in and the island never reads it again); and devtools builds, whose
 * byte ledger reads the text.
 */
let sidecar_readers: Map<string, number> | null = null;
export function release_sidecar(region: Element, sidecar: Element): void {
	if (DEVTOOLS) return;
	const fp = region.getAttribute('data-og-fp');
	if (!fp || sidecar.getAttribute('data-ogygia-props') !== fp) return;
	if (region.ownerDocument !== document || inside_frozen(region)) return;
	if (!sidecar_readers) {
		sidecar_readers = new Map();
		for (const el of document.querySelectorAll('ogygia-region[data-og-fp]')) {
			const f = el.getAttribute('data-og-fp') as string;
			sidecar_readers.set(f, (sidecar_readers.get(f) ?? 0) + 1);
		}
	}
	const left = (sidecar_readers.get(fp) ?? 1) - 1;
	sidecar_readers.set(fp, left);
	if (left <= 0) sidecar.textContent = '';
}

type PageSeed = Partial<Omit<PageSnapshot, 'url'> & { url: string | URL }>;

let parses = 0;
/** Test seam: how many page-seed scripts were parsed since boot (one per document is the law). */
export function seed_parse_count(): number {
	return parses;
}

/** Parse one page-seed script; `null` when malformed. Blanks the text once parsed (see above). */
function parse_page_seed(el: Element): PageSeed | null {
	parses++;
	try {
		// Install the live resolver (drains any resolve script that raced ahead) BEFORE reviving, so a
		// defer marker becomes a pending Promise that a queued resolution can settle immediately. Both
		// the seed and the streamed resolves revive with the app's transport decoders, so a load's
		// CUSTOM types round-trip into islands.
		install_page_defer(transport_decoders);
		const raw = parse_sidecar_text(el, page_defer_revivers(transport_decoders)) as PageSeed;
		if (slots.nav && !DEVTOOLS) el.textContent = '';
		return raw;
	} catch {
		return null;
	}
}

/** Feed a parsed seed into the `$app/state` page store (the devalue href string becomes a `URL`). */
function apply_page_seed(raw: PageSeed | null): void {
	if (!raw) return;
	let url: URL | undefined;
	if (raw.url instanceof URL) url = raw.url;
	else if (typeof raw.url === 'string') {
		try {
			url = new URL(raw.url);
		} catch {
			url = undefined;
		}
	}
	set_page({ ...raw, url });
}

/** Foreign (fetched) documents' seeds, one parse per `Document`. */
const foreign_seeds = new WeakMap<Document, PageSeed | null>();

/**
 * The parsed seed of a document that is NOT the live one (a navigation's incoming document): parsed
 * on first ask, remembered on the document. The router asks in its preflight (off the view
 * transition's critical path); the soft-invalidate and any kept island's props absorb reuse it.
 */
export function page_seed_of(doc: Document): PageSeed | null {
	const hit = foreign_seeds.get(doc);
	if (hit !== undefined) return hit;
	const el = doc.querySelector(PAGE_SEED_SELECTOR);
	const seed = el ? parse_page_seed(el) : null;
	foreign_seeds.set(doc, seed);
	return seed;
}

/**
 * The `data` a seed reference resolves against: the live page store for the live document (seeded
 * on first ask), the once-parsed seed for a foreign one. `undefined` when the document has no seed.
 */
export function seed_data_of(doc: Document): unknown {
	if (typeof document !== 'undefined' && doc === document) {
		seed_page_once();
		return page_state.data;
	}
	return page_seed_of(doc)?.data;
}

/** Apply `application/ogygia-remote` text into the reused Kit query seed bag. */
function apply_remote_seed_text(text: string | null | undefined): void {
	if (!text) return;
	slots.remoteSeeds?.seed_query_responses(text);
}

// Flicker fix: seed the reused Kit client query cache from the server's side-channel script
// (emitted by `ogygiaHandle` on csr=false pages) exactly ONCE per document, before any island's
// reused `Query` constructor reads `query_responses`. Cleared on SPA body swap.
export function seed_remote_once(): void {
	if (runtime_session.remote_seeded) return;
	runtime_session.mark_remote_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector(REMOTE_SEED_SELECTOR);
	apply_remote_seed_text(el?.textContent);
}

/** Document-level page seed (one script from ogygiaHandle) — once per document. */
export function seed_page_once(): void {
	if (runtime_session.page_seeded) return;
	runtime_session.mark_page_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector(PAGE_SEED_SELECTOR);
	if (el) apply_page_seed(parse_page_seed(el));
}

/**
 * Soft invalidate: refresh document-level page + remote **seeds** from a fetched HTML document
 * without replacing `<body>`, remounting islands, or clearing live query/live instance maps. The
 * router runs it on every navigation (before the body morph — seeds first, DOM second) and
 * `invalidateAll` runs it alone, so Kit remote `form()` success does not view-transition wipe live
 * island state. It is the ONLY seed writer on a navigation and marks the document seeded, so the
 * next island to wake never re-parses. Does **not** auto-refresh live queries — callers that need
 * that use `.refresh()`, or `submit().updates(q)` with server `requested(q).refreshAll()`.
 */
export function apply_soft_invalidate_doc(doc: Document): void {
	if (typeof document === 'undefined') return;
	// Seed bag only — never clear_remote_instances() here (live Query/LiveQuery stay mounted).
	slots.remoteSeeds?.clear_remote_seeds();
	apply_remote_seed_text(doc.querySelector(REMOTE_SEED_SELECTOR)?.textContent);
	runtime_session.mark_remote_seeded();
	// The incoming page seed: parsed once for this document (already, when the router preflighted).
	apply_page_seed(page_seed_of(doc));
	runtime_session.mark_page_seeded();
}

/**
 * Reset per-document session + SSR remote seeds before a new body connects.
 *
 * Do **not** clear `query_map` / `live_query_map` here — old islands are still mounted, and Kit's
 * LiveQueryProxy throws if its cache entry vanishes mid-render. Instance sweep happens in
 * {@link finish_spa_document} after the swap.
 */
export function prepare_spa_document(): void {
	runtime_session.reset();
	slots.remoteSeeds?.clear_remote_seeds();
	invalidate_hint_set();
	sidecar_readers = null;
	reset_page();
}

/**
 * After the body swap: old islands have disconnected; new ones have only queued their hydrate.
 * Sweep Kit query/live instance maps so the next page cannot reuse a LiveQuery whose `#start` is
 * already spent (`once`) — that reuse never opens SSE again and leaves "connecting…".
 */
export function finish_spa_document(): void {
	slots.remoteSeeds?.clear_remote_instances();
}
