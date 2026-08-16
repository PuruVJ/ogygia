/**
 * The CMS-backed ogygia site, on the NEW content API. Every wart the old APIs forced is gone:
 *  - order is DATA (`order: [categoryPos, pagePos]`), not a fake `NN-` filePath smuggled through a string;
 *  - section labels come from the `groups()` facet, not a second hand-built collection;
 *  - `refs()` is a shallow index fetch (no bodies on the wire); `get()` fetches one full document.
 * The loader shape now matches the CMS's own endpoints 1:1.
 */
import { blocks, content, type RawRecord, type RawSource } from 'ogygia/content';
import { fields, contentkit } from 'ogygia/content';
import { registry } from './blocks/registry';

// A CMS is external, so its address is config (env in production). Request-blind by design.
const CMS = 'http://localhost:5281/api';

type CmsRow = {
	id: string;
	slug: string;
	category: string;
	position: number;
	title: string;
	summary: string;
	draft: boolean;
	related: string[];
	redirect_from: string[];
	body?: unknown[];
};
type CmsCategory = { id: string; name: string; position: number };

/** The category table, fetched once (labels + positions for the nav groups). */
const categories_once = (() => {
	let p: Promise<CmsCategory[]> | null = null;
	return () => (p ??= fetch(`${CMS}/categories`).then((r) => r.json()));
})();

const frontmatter = (row: CmsRow) => ({
	title: row.title,
	summary: row.summary,
	draft: row.draft,
	related: row.related,
	redirect_from: row.redirect_from
});

/** Sibling order as DATA: [category position, page position] — aligns with the two id levels. */
function order_of(row: CmsRow, cats: CmsCategory[]): number[] {
	const cat = cats.find((c) => c.id === row.category);
	return [cat?.position ?? 99, row.position];
}

const cms_pages: RawSource<unknown> = {
	// The corpus as metadata — ONE shallow request, no bodies on the wire.
	async refs(): Promise<RawRecord<unknown>[]> {
		const [rows, cats] = await Promise.all([
			fetch(`${CMS}/pages`).then((r) => r.json() as Promise<CmsRow[]>),
			categories_once()
		]);
		return rows.map((row) => ({ id: row.id, value: { blocks: [], meta: frontmatter(row) }, order: order_of(row, cats) }));
	},
	// One full document — the only fetch that pulls a body.
	async get(id): Promise<RawRecord<unknown> | null> {
		const res = await fetch(`${CMS}/pages/${id}`);
		if (!res.ok) return null;
		const [row, cats] = [(await res.json()) as CmsRow, await categories_once()];
		return { id, value: { blocks: row.body ?? [], meta: frontmatter(row) }, order: order_of(row, cats) };
	},
	// Section labels straight from the CMS's own category API — no fake meta collection.
	async groups() {
		const cats = await categories_once();
		return new Map(cats.map((c) => [c.id, { label: c.name }]));
	}
};

export const docs = content({
	loader: blocks(cms_pages, registry),
	schema: fields.page, // the blessed frontmatter contract, dogfooded
	relations: (self) => ({ related: self }),
	// draft pages are hidden — unless the request carries preview context.
	filter: (e, ctx) => !e.data.draft || ctx.preview === true
});

/** Preview context from the URL (`?preview=secret`) — universal-load-safe (no cookies API there).
 *  Exported so the page component derives the SAME context it renders under as the load guard used. */
export const preview_ctx = (url: URL) => ({ preview: url.searchParams.get('preview') === 'secret' });

export const site = contentkit({
	outline: docs,
	data: { title: 'CMS Playground', description: 'An ogygia site sourced entirely from a REST CMS.', origin: 'http://localhost:5281' },
	prevNext: 'graph',
	// Preview mode: `?preview=secret` flips draft visibility. The loader stays request-blind; only the
	// filter sees ctx, and the weave memoizes one tree per distinct context (public vs preview).
	context: (event) => preview_ctx(event.url)
});
