/**
 * The fake headless CMS — an in-memory "database" shaped like a conventional one (Contentful /
 * Strapi / Hasura table view): categories with `position` + display `name`, pages with `position`,
 * flags, and a Builder-style block tree as the body. The REST routes under `/api` are its only door;
 * the ogygia loader talks to those over HTTP like it would to a real CMS.
 */

export type CmsCategory = {
	id: string;
	name: string;
	position: number;
};

export type CmsBlock = {
	type: string;
	props?: Record<string, unknown>;
	children?: CmsBlock[];
};

export type CmsPage = {
	slug: string; // unique within its category
	category: string; // FK → CmsCategory.id
	position: number; // sibling order within the category
	title: string;
	summary: string;
	draft: boolean;
	related: string[]; // full ids ("category/slug") of related pages
	redirect_from: string[]; // old addresses this page used to live at
	body: CmsBlock[];
};

export const categories: CmsCategory[] = [
	{ id: 'start', name: 'Getting started', position: 1 },
	{ id: 'concepts', name: 'Core concepts', position: 2 },
	{ id: 'recipes', name: 'Recipes & patterns', position: 3 }
];

export const pages: CmsPage[] = [
	{
		slug: 'welcome',
		category: 'start',
		position: 1,
		title: 'Welcome',
		summary: 'What this playground proves.',
		draft: false,
		related: ['concepts/loaders'],
		redirect_from: [],
		body: [
			{ type: 'Hero', props: { title: 'Docs from a CMS', tagline: 'Every word on this page arrived over HTTP.' } },
			{ type: 'Prose', props: { text: 'This site has no markdown files. A fake headless CMS serves pages, categories, order and labels through a REST API, and an ogygia content loader turns them into the same collections the filesystem sites use.' } },
			{ type: 'Callout', props: { tone: 'info', text: 'The sidebar order and the section names come from CMS position fields and category names — no NN- folders anywhere.' } }
		]
	},
	{
		slug: 'install',
		category: 'start',
		position: 2,
		title: 'Install',
		summary: 'Wire the loader in three steps.',
		draft: false,
		related: [],
		redirect_from: ['start/setup'],
		body: [
			{ type: 'Prose', props: { text: 'A CMS-backed collection is a loader with get, list and ids — each one a fetch.' } },
			{ type: 'Code', props: { lang: 'ts', code: "const raw = {\n  get: (id) => fetch(`${CMS}/pages/${id}`).then(to_record),\n  list: () => fetch(`${CMS}/pages?full=1`).then(to_records),\n  ids: () => fetch(`${CMS}/pages`).then(to_ids)\n};" } },
			{ type: 'Callout', props: { tone: 'warn', text: 'This page also declares redirect_from: ["start/setup"] in the CMS — visiting /start/setup 308s here.' } }
		]
	},
	{
		slug: 'first-page',
		category: 'start',
		position: 3,
		title: 'Your first page',
		summary: 'Author a page in the CMS and watch it appear.',
		draft: false,
		related: [],
		redirect_from: [],
		body: [
			{ type: 'Prose', props: { text: 'Add a row to the pages table, give it a category and a position, and the outline places it — same weave, different corpus.' } }
		]
	},
	{
		slug: 'loaders',
		category: 'concepts',
		position: 1,
		title: 'Loaders',
		summary: 'get / list / ids over the wire.',
		draft: false,
		related: ['start/install'],
		redirect_from: [],
		body: [
			{ type: 'Prose', props: { text: 'A loader is the whole contract between ogygia and a backend. The filesystem is one loader; this REST API is another; the collection cannot tell them apart.' } }
		]
	},
	{
		slug: 'islands',
		category: 'concepts',
		position: 2,
		title: 'Islands from CMS data',
		summary: 'A live counter, declared as a block row.',
		draft: false,
		related: [],
		redirect_from: [],
		body: [
			{ type: 'Prose', props: { text: 'The block below is a row in the CMS body tree: { type: "Counter", props: { start: 5 } }. The registry maps it to a Svelte island that hydrates on visibility.' } },
			{ type: 'Counter', props: { start: 5 } },
			{ type: 'Prose', props: { text: 'Everything around it stays HTML-only — blocks without a wake schedule ship zero JS.' } }
		]
	},
	{
		slug: 'live-preview',
		category: 'recipes',
		position: 1,
		title: 'Live preview',
		summary: 'Where a live() loader facet would plug in.',
		draft: false,
		related: [],
		redirect_from: [],
		body: [
			{ type: 'Prose', props: { text: 'A CMS loader may expose live() — an async iterable of changed ids. The collection re-reads just those entries; a draft toggled in the CMS pops in and out of the nav.' } }
		]
	},
	{
		slug: 'unpublished',
		category: 'recipes',
		position: 2,
		title: 'Draft: not published yet',
		summary: 'You should never see this page.',
		draft: true,
		related: [],
		redirect_from: [],
		body: [{ type: 'Prose', props: { text: 'Filtered out by the collection filter — invisible in nav, entries and direct URL.' } }]
	}
];

export const page_id = (p: CmsPage) => `${p.category}/${p.slug}`;

export function find_page(id: string): CmsPage | undefined {
	return pages.find((p) => page_id(p) === id);
}
