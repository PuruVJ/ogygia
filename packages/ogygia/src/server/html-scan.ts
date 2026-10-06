/**
 * Small hand-written scans shared by the server's per-request HTML work, each kept only where it
 * MEASURED faster (or allocation-lighter) than the regex it replaced — the engine's compiled
 * matcher wins plain presence tests, so those stayed regexes (head-presence.ts).
 */

/** `[A-Za-z0-9_]` — the regex `\w` (NaN, past the end, is not). */
export function is_word(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

/** The regex `\s`: ASCII whitespace and the Unicode spaces (NaN, past the end, is not). */
export function is_space(c: number): boolean {
	if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
	if (c < 160) return false;
	return (
		c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
		c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
	);
}

const REGION_CSS_ATTR = 'data-ogygia-region-css';

/**
 * Every region-CSS tag in `head`, in order, joined: the `<link … data-ogygia-region-css>` form AND the
 * inline `<style data-ogygia-region-css="href">…</style>` form a sheet under Kit's
 * `inlineStyleThreshold` takes. What an isolated render (a held region's body) must carry forward
 * from its head: keeping links only silently unstyled every small sheet.
 */
export function region_css_tags(head: string): string {
	let out = '';
	for (
		let attr = head.indexOf(REGION_CSS_ATTR);
		attr !== -1;
		attr = head.indexOf(REGION_CSS_ATTR, attr + 1)
	) {
		const open = head.lastIndexOf('<', attr);
		if (open === -1) continue;
		if (head.startsWith('<link', open) && !is_word(head.charCodeAt(open + 5))) {
			const end = head.indexOf('>', attr);
			if (end === -1) break;
			out += head.slice(open, end + 1);
			attr = end;
		} else if (head.startsWith('<style', open) && !is_word(head.charCodeAt(open + 6))) {
			const close = head.indexOf('</style>', attr);
			if (close === -1) break;
			out += head.slice(open, close + 8);
			attr = close + 7;
		}
	}
	return out;
}

/** Every `<link …data-ogygia-region-css…>` tag in `head`, in order, joined — what
 *  `head.match(/<link\b[^>]*data-ogygia-region-css[^>]*>/g).join('')` returned. */
export function region_css_links(head: string): string {
	let out = '';
	// (the next attribute occurrence is found once and reused until the walk passes it: linear)
	let attr = head.indexOf('data-ogygia-region-css');
	if (attr === -1) return '';
	for (let at = head.indexOf('<link'); at !== -1; at = head.indexOf('<link', at + 5)) {
		if (is_word(head.charCodeAt(at + 5))) continue;
		const end = head.indexOf('>', at);
		if (end === -1) break;
		if (attr < at) attr = head.indexOf('data-ogygia-region-css', at);
		if (attr === -1) break;
		if (attr < end) out += head.slice(at, end + 1);
		at = end - 4; // (resume after the tag)
	}
	return out;
}
