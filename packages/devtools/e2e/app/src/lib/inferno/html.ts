// A post-render HTML pass and a string-built list, the way a CMS integration often has them.
// The comment on each says which slow pattern the profiler should name.
import { BADGES } from './data';

/** PATTERN rescan-in-loop: every badge token replaced with a pass over the whole page */
export function injectBadges(html: string): string {
	for (const b of BADGES) html = html.replaceAll(b.token, b.html);
	return html;
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** PATTERN string-build: a long list grown with += in a loop */
export function sitemapHtml(items: { id: string; name: string; tags: string[] }[]): string {
	let out = '<ul class="sitemap">';
	for (const i of items) out += '<li data-id="' + i.id + '">' + esc(i.name) + ' — ' + i.tags.join(', ') + ' %%BADGE_' + (i.id.length % 40) + '%%</li>';
	return out + '</ul>';
}
