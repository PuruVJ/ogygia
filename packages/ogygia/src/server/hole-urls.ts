/**
 * Absolute URLs inside a hole's HTML.
 *
 * A server island renders in its OWN request — `/__ogygia__?…` — and Kit's `asset()` (with the
 * default `paths.relative`) emits every URL relative to THAT request: `./_app/immutable/x.js`,
 * `./__ogygia__?…`. The HTML then lands in a page at any depth (`/docs/guides/`), and a
 * region entry / nested-hole endpoint / region-css link inside it would resolve against the page:
 * `/docs/guides/_app/…` → 404, a dead island in a live hole. The batch parcel and an
 * ESI-stitched hole (the CDN splices the bytes straight into the page) have the same problem, so
 * the fix is on the server, once, at the point the response is assembled: resolve every relative
 * ogygia URL against the endpoint request URL and emit it root-absolute (Kit `base` included).
 * Absolute (`/…`) and scheme'd (foreign federation entries) values are left alone.
 */
import { escape_amp } from '../escape.js';

// The three attribute sites ogygia writes URLs into hole HTML: an `<ogygia-region>`'s `entry` /
// `endpoint`, a region-css `<link>`'s `href`, an inlined region sheet's `data-ogygia-region-css`
// identity. Values are attribute-escaped (`&` → `&amp;`), so the resolver un-escapes, resolves, and
// re-escapes. ONE forward walk over the tags (indexOf; it used to be three whole-body regex passes
// on every hole answer), each rewritten only when it holds a relative value.
const REGION_CSS_ATTR = 'data-ogygia-region-css';

function is_word(c: number): boolean {
	return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function resolve_attr(value: string, base: URL): string {
	if (!value || !(value.startsWith('./') || value.startsWith('../'))) return value;
	let resolved: URL;
	try {
		resolved = new URL(value.indexOf('&amp;') === -1 ? value : value.replaceAll('&amp;', '&'), base);
	} catch {
		return value;
	}
	if (resolved.origin !== base.origin) return value;
	return escape_amp(resolved.pathname + resolved.search + resolved.hash);
}

/** Rewrite `name="…"` in `tag` (a word boundary before `name`; every occurrence, or the first). */
function rewrite_attr(tag: string, name: string, base: URL, all: boolean): string {
	const needle = name + '="';
	let out = '';
	let pos = 0;
	for (let at = tag.indexOf(needle); at !== -1; at = tag.indexOf(needle, at + needle.length)) {
		if (at > 0 && is_word(tag.charCodeAt(at - 1))) continue;
		const start = at + needle.length;
		const end = tag.indexOf('"', start);
		if (end === -1) break;
		out += tag.slice(pos, start) + resolve_attr(tag.slice(start, end), base);
		pos = end;
		if (!all) break;
	}
	return pos === 0 ? tag : out + tag.slice(pos);
}

/** Does a tag named `name` open at `lt` (`<name` then a non-word character)? */
function opens(html: string, lt: number, name: string): boolean {
	return html.startsWith(name, lt + 1) && !is_word(html.charCodeAt(lt + 1 + name.length));
}

/** Rewrite the relative `entry` / `endpoint` / region-css `href` values in `html` to root-absolute
 *  paths resolved against `base` (the endpoint request URL). */
export function absolutize_hole_html(html: string, base: URL): string {
	if (!html.includes('<ogygia-region') && !html.includes(REGION_CSS_ATTR)) return html;
	let out = '';
	let pos = 0;
	for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', lt + 1)) {
		const region = opens(html, lt, 'ogygia-region');
		const link = !region && opens(html, lt, 'link');
		const style = !region && !link && opens(html, lt, 'style');
		if (!region && !link && !style) continue;
		const gt = html.indexOf('>', lt);
		if (gt === -1) break;
		const tag = html.slice(lt, gt + 1);
		let next = tag;
		if (region) next = rewrite_attr(rewrite_attr(tag, 'entry', base, true), 'endpoint', base, true);
		else if (tag.indexOf(REGION_CSS_ATTR) !== -1) next = link ? rewrite_attr(tag, 'href', base, false) : tag.indexOf(REGION_CSS_ATTR + '="') !== -1 ? rewrite_attr(tag, REGION_CSS_ATTR, base, false) : tag;
		if (next !== tag) {
			out += html.slice(pos, lt) + next;
			pos = gt + 1;
		}
		lt = gt;
	}
	return pos === 0 ? html : out + html.slice(pos);
}
