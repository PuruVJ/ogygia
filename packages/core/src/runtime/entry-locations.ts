/**
 * ENTRY IDENTITY → LOCATION, the browser's half (server/entry-location.ts is the server's).
 *
 * An island's `entry` is its IDENTITY: the stable URL every key uses (the island graph, the
 * fingerprint, the devtools' names). The file to import is its LOCATION — content-hashed, so an
 * `immutable` cache never serves a stale one. The server writes it beside the identity: the region
 * element's `src`, and the island graph's `s` map for an entry no element carries (a portable
 * snippet's). Every loader resolves through `island_module_url` (region-endpoint-url.ts), which asks
 * here first: the location once one is known, else the identity (the dev server, or a page from
 * before hashing — whose stable name is a shim that reaches the current build).
 */

/** absolute identity → absolute location */
const locations = new Map<string, string>();

/** A load that fell back to its identity: who hears about it (the runtime registers the devtools
 *  and beacon reporter at boot). This module imports nothing: app code (a portable snippet) uses it
 *  too, and must not pull the runtime's reporting into the app's chunks. */
export type EntryFallbackReport = { entry: string; src: string; recovered: boolean };
let fallback_reporter: ((report: EntryFallbackReport) => void) | null = null;
export function on_entry_fallback(reporter: (report: EntryFallbackReport) => void): void {
	fallback_reporter = reporter;
}

/** Resolved URLs by base + url: every wake, warm and graph read asks again for the same few
 *  entries, and each ask was a `new URL()` parse (bounded: cleared past a few thousand). */
const resolved_urls = new Map<string, string>();

function absolute(url: string, base?: string): string {
	const b = base ?? location.href;
	const key = b + '\n' + url;
	const hit = resolved_urls.get(key);
	if (hit !== undefined) return hit;
	let out: string;
	try {
		out = new URL(url, b).href;
	} catch {
		out = url;
	}
	if (resolved_urls.size > 4000) resolved_urls.clear();
	resolved_urls.set(key, out);
	return out;
}

/** Remember where an entry is served from. `base`: the document the pair was read from. */
export function note_entry_location(entry: string | null | undefined, src: string | null | undefined, base?: string): void {
	if (!entry || !src || src === entry) return;
	locations.set(absolute(entry, base), absolute(src, base));
}

/** The known location of an entry, or undefined. */
export function entry_location(entry: string, base?: string): string | undefined {
	return locations.size ? locations.get(absolute(entry, base)) : undefined;
}

/** The region attributes that hold a URL: its identity, its location, its hole's endpoint. */
const REGION_URL_ATTRS = ['entry', 'src', 'endpoint'] as const;

/**
 * PIN A REGION'S URLS TO THE PAGE THAT WROTE THEM. With Kit's default `paths.relative`, the server
 * writes `entry` / `src` / `endpoint` relative to the page it rendered (`../../_app/immutable/…`,
 * `../../__ogygia__?…`), and every reader resolves them against `location.href`. A region that stays
 * on the page through a client navigation (Kit's, or the router's) then resolved them against the
 * NEW address: its island imported `/a/b/_app/…` (a redirect to an HTML page), and a hole's key
 * changed with the depth of the page, so a swap kept the old region beside the new one. Resolved
 * once, where the address is still the right one — the element's connect, and a fetched document
 * against its own URL — they read the same on every page. Same origin only (a federated entry stays
 * as written); an absolute or root-absolute value is already pinned.
 */
export function pin_region_urls(el: Element, base?: string): void {
	for (const name of REGION_URL_ATTRS) {
		const value = el.getAttribute(name);
		if (!value || !(value.startsWith('./') || value.startsWith('../'))) continue;
		let url: URL;
		try {
			url = new URL(absolute(value, base));
		} catch {
			continue;
		}
		if (url.origin === location.origin) el.setAttribute(name, url.pathname + url.search + url.hash);
	}
}

/** An island element's identity, its location noted on the way (the one read every loader uses). */
export function island_entry_of(el: Element): string | null {
	const entry = el.getAttribute('entry');
	if (entry) note_entry_location(entry, el.getAttribute('src'));
	return entry;
}

/**
 * The identity itself, past every cache: what a load falls back to when its location failed (a page
 * a cache kept outlived the build that made it, and that build's files are gone). The stable name
 * is a shim of the CURRENT build's file; the query makes the browser fetch it fresh rather than the
 * copy an `immutable` cache may hold. Null when no location was known (nothing to fall back to).
 */
function fresh_identity_url(entry: string, base?: string): string | null {
	if (!entry_location(entry, base)) return null;
	const identity = absolute(entry, base);
	return identity + (identity.includes('?') ? '&' : '?') + 'og-fresh=' + Date.now().toString(36);
}

/**
 * Import an entry: its location when known, else `url` (what the caller resolved for the identity);
 * the location failing, once, the identity fetched fresh — so an island on a page that outlived its
 * build still wakes, on the current code. No location known → the error stands.
 */
export function import_entry<T>(entry: string, url: string = entry_location(entry) ?? entry): Promise<T> {
	const loaded = import(/* @vite-ignore */ url) as Promise<T>;
	const fresh = fresh_identity_url(entry);
	if (!fresh) return loaded;
	return loaded.catch(() => {
		const retry = import(/* @vite-ignore */ fresh) as Promise<T>;
		// said out loud: the page's HTML is one build, this island's code the current one (devtools'
		// timeline, and the beacon — the Page tab and the profiler name it)
		const report = (recovered: boolean) => fallback_reporter?.({ entry, src: url, recovered });
		retry.then(
			() => report(true),
			() => report(false)
		);
		return retry;
	});
}
