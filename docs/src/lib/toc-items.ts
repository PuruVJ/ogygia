/**
 * Sidebar nav is derived entirely from the filesystem: `NN-section/NN-page/+doc.svx`.
 * The `NN-` folder prefixes set section + page order; they are stripped from the URL slug.
 * No `section` / `order` frontmatter, no hand-maintained nav list.
 */

/** One nav entry, as delivered by the `docNav` remote. */
export type DocNavItem = {
	slug: string;
	title: string;
	section: string;
	sectionOrder: number;
	order: number;
};

/** Optional display-name overrides for section slugs (default: Title Case the slug). */
const SECTION_LABELS: Record<string, string> = {
	'data-state': 'Data & state'
};

function titleCase(slug: string): string {
	return slug
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Parse a doc file path → section + order from its `NN-` folder prefixes.
 * `…/content/docs/00-start/01-install/+doc.svx` → { section: 'Start', sectionOrder: 0, order: 1 }.
 */
export function parseDocPath(filePath: string): {
	section: string;
	sectionOrder: number;
	order: number;
} {
	const rel = filePath
		.replace(/\\/g, '/')
		.replace(/.*content\/docs\//, '')
		.replace(/\/\+doc\.svx$/, '');
	const parts = rel.split('/');
	const sectionDir = parts[0] ?? '';
	const pageDir = parts[1] ?? '';
	const sm = sectionDir.match(/^(\d+)-(.+)$/);
	const pm = pageDir.match(/^(\d+)-(.+)$/);
	const sectionSlug = sm ? sm[2] : sectionDir;
	return {
		section: SECTION_LABELS[sectionSlug] ?? titleCase(sectionSlug),
		sectionOrder: sm ? Number(sm[1]) : 999,
		order: pm ? Number(pm[1]) : 999
	};
}

/** Group flat nav items into sections, ordered by the FS prefixes. */
export function groupNav(items: DocNavItem[]): { section: string; items: DocNavItem[] }[] {
	const bySection = new Map<string, { sectionOrder: number; items: DocNavItem[] }>();
	for (const it of items) {
		let g = bySection.get(it.section);
		if (!g) {
			g = { sectionOrder: it.sectionOrder, items: [] };
			bySection.set(it.section, g);
		}
		g.items.push(it);
	}
	return [...bySection.entries()]
		.sort((a, b) => a[1].sectionOrder - b[1].sectionOrder)
		.map(([section, g]) => ({
			section,
			items: g.items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
		}));
}

/** `/docs/<slug>` for a nav item. */
export function docHref(slug: string): string {
	return `/docs/${slug}`;
}

/** Section display label for a slug (`start/install` → `Start`). */
export function sectionLabel(slug: string): string {
	const seg = slug.split('/')[0] ?? '';
	return SECTION_LABELS[seg] ?? titleCase(seg);
}
