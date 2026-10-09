/**
 * Emissions — machine-facing serializations of the site, the second audience docs have in 2026.
 * Pure functions over a resolved `NavTree`: a sitemap for crawlers, an `llms.txt` index for models.
 * No I/O, no request — `site()` wraps these in GET handlers that supply the origin. Leaf hrefs are
 * already mount-resolved (root-relative), so an absolute URL is just `origin + href`.
 *
 * (Per-page raw `.md` / `llms-full.txt` need the entry SOURCE text, which the content pillar does not
 * retain — it stores compiled bodies. That waits on a raw-source companion; it is not here yet.)
 */
import type { NavItem, NavLeaf, NavTree } from './types.js';

// ── regexes
const FRONTMATTER_BLOCK_RE = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const LEADING_WS_RE = /^\s+/;
const XML_SPECIAL_G = /[&<>"']/g;
const EXCESS_BLANK_LINES_G = /\n{3,}/g;

/** Strip a leading YAML frontmatter block (and a leading BOM) so the `.md` is clean prose+script. */
export function strip_frontmatter(src: string): string {
	return src.replace(FRONTMATTER_BLOCK_RE, '').replace(LEADING_WS_RE, '');
}

function xml_escape(s: string): string {
	return s.replace(
		XML_SPECIAL_G,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
	);
}

/** Depth-first list of every leaf under a set of items (nested groups flattened). */
function leaves_of(items: NavTree): NavLeaf[] {
	const out: NavLeaf[] = [];
	for (const item of items) {
		if (item.kind === 'leaf') out.push(item);
		else if (item.kind === 'group') out.push(...leaves_of(item.items));
	}
	return out;
}

/** A sitemap.xml over every leaf, absolute-URL'd against `origin`. */
export function build_sitemap(tree: NavTree, origin: string): string {
	const urls = leaves_of(tree)
		.map((l) => `  <url><loc>${xml_escape(origin + l.href)}</loc></url>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** One `- [title](url): summary` line for a leaf or link. */
function bullet(item: NavItem, origin: string): string | null {
	if (item.kind === 'leaf')
		return `- [${item.title}](${origin + item.href})${item.summary ? `: ${item.summary}` : ''}`;
	if (item.kind === 'link') return `- [${item.label}](${item.href})`;
	return null;
}

/** Flatten a section's items to bullet lines (nested groups contribute their leaves). */
function section_bullets(items: NavTree, origin: string): string[] {
	const out: string[] = [];
	for (const item of items) {
		if (item.kind === 'group') out.push(...section_bullets(item.items, origin));
		else {
			const b = bullet(item, origin);
			if (b) out.push(b);
		}
	}
	return out;
}

export type LlmsOptions = { title?: string; description?: string };

/**
 * An `llms.txt` index (llmstxt.org shape): an H1 title, an optional blockquote description, then one
 * H2 per top-level group with a bulleted link list. Loose top-level pages/links go under `## Pages`.
 */
export function build_llms(tree: NavTree, origin: string, opts: LlmsOptions = {}): string {
	const lines: string[] = [`# ${opts.title ?? 'Documentation'}`, ''];
	if (opts.description) lines.push(`> ${opts.description}`, '');

	const loose = tree.filter((n) => n.kind !== 'group');
	if (loose.length) {
		lines.push('## Pages', '');
		for (const n of loose) {
			const b = bullet(n, origin);
			if (b) lines.push(b);
		}
		lines.push('');
	}

	for (const n of tree) {
		if (n.kind !== 'group') continue;
		lines.push(`## ${n.label}`, '');
		lines.push(...section_bullets(n.items, origin));
		lines.push('');
	}

	return lines.join('\n').replace(EXCESS_BLANK_LINES_G, '\n\n').trimEnd() + '\n';
}

// ── RSS — the blog genre's emission ──────────────────────────────────────────────

/** One feed item. `href` is root-relative (the emitter absolutizes); `date` is ISO `YYYY-MM-DD`. */
export type RssItem = { href: string; title: string; description?: string; date: string };

export type RssOptions = {
	/** Channel title (`Svelte blog`). */
	title: string;
	/** Channel description. */
	description?: string;
	/** The section's mount (`/blog`) — becomes the channel link. */
	base: string;
	/** Feed items, newest-first preferred (the emitter re-sorts by date DESC to be safe). */
	items: RssItem[];
};

/** Pure RSS 2.0 over a list of dated items — same contract as the other emissions: no I/O, the
 *  caller supplies the origin. */
export function build_rss(origin: string, opts: RssOptions): string {
	const items = [...opts.items].sort((a, b) => (a.date < b.date ? 1 : -1));
	const rows = items
		.map((p) => {
			const url = origin + p.href;
			return [
				`\t\t<item>`,
				`\t\t\t<title>${xml_escape(p.title)}</title>`,
				`\t\t\t<link>${xml_escape(url)}</link>`,
				`\t\t\t<guid isPermaLink="true">${xml_escape(url)}</guid>`,
				...(p.description ? [`\t\t\t<description>${xml_escape(p.description)}</description>`] : []),
				`\t\t\t<pubDate>${new Date(p.date + 'T00:00:00Z').toUTCString()}</pubDate>`,
				`\t\t</item>`
			].join('\n');
		})
		.join('\n');
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<rss version="2.0">`,
		`\t<channel>`,
		`\t\t<title>${xml_escape(opts.title)}</title>`,
		`\t\t<link>${xml_escape(origin + opts.base)}</link>`,
		...(opts.description ? [`\t\t<description>${xml_escape(opts.description)}</description>`] : []),
		rows,
		`\t</channel>`,
		`</rss>`
	].join('\n');
}
