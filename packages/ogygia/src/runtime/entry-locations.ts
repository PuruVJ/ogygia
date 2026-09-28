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

function absolute(url: string, base?: string): string {
	try {
		return new URL(url, base ?? location.href).href;
	} catch {
		return url;
	}
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
	return fresh ? loaded.catch(() => import(/* @vite-ignore */ fresh) as Promise<T>) : loaded;
}
