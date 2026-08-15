/**
 * The pharos playground site — a rich, multi-category docs weave for stressing the design system.
 *
 * Nav is intentionally FLAT (2 levels): each top-level category is one collection, and its pages list
 * directly under it — category → page, no third level. A `dimensions()` wrap adds a version × locale
 * switcher (the default v2 · en corpus is rich; v1 / hi are thin, to demo the header dropdowns).
 */
import { content, folder } from 'ogygia/content';
import { dimensions, outline, pharos } from 'ogygia/pharos';
import * as v from 'valibot';
import { openapi } from './openapi';

const guide_schema = v.object({
	title: v.string(),
	summary: v.optional(v.string(), ''),
	draft: v.optional(v.boolean(), false),
	related: v.optional(v.array(v.string()), []),
	// Old addresses this page used to live at — pharos serves a baked 308 for each.
	redirect_from: v.optional(v.array(v.string()), [])
});
export type GuideData = v.InferOutput<typeof guide_schema>;
const guide_opts = {
	schema: guide_schema,
	filter: (e: { data: GuideData }) => !e.data.draft
} as const;

// One collection PER CATEGORY — each renders as a flat group in the sidebar (2-level nav). `folder()`
// derives clean flat ids + `NN-` sibling order from each category's own glob (no id fn, order as data).
const getting_started = content({
	loader: folder(import.meta.glob('../content/guides/getting-started/**/+doc.svx', { eager: true })),
	...guide_opts
});
const concepts = content({
	loader: folder(import.meta.glob('../content/guides/concepts/**/+doc.svx', { eager: true })),
	...guide_opts
});
const guides_cat = content({
	loader: folder(import.meta.glob('../content/guides/guides/**/+doc.svx', { eager: true })),
	...guide_opts
});
const showcase = content({
	loader: folder(import.meta.glob('../content/guides/showcase/**/+doc.svx', { eager: true })),
	...guide_opts
});

// The API REFERENCE — a real OpenAPI 3 spec, flattened to an entry per operation by the hand-written
// `openapi()` source (see ./openapi.ts). Grouped by tag → operation, mounted under `/api`. Data-only
// (structured `data`, no markdown body); the `[...slug]` route renders it with `OperationDoc`.
export const api = content({
	loader: openapi(import.meta.glob('../content/openapi/*.json', { eager: true, import: 'default' }))
});

// Thin alternate corpora — just enough to make the version / locale switcher real.
const v1 = content({
	loader: folder(import.meta.glob('../content/v1/**/+doc.svx', { eager: true })),
	...guide_opts
});
const hi = content({
	loader: folder(import.meta.glob('../content/hi/**/+doc.svx', { eager: true })),
	...guide_opts
});

const github = { label: 'GitHub', href: 'https://github.com/PuruVJ/ogygia' } as const;
const reference = { label: 'Reference', items: api, base: 'api', collapsed: true } as const;

// The rich default corpus (v2 · en) — flat categories. `base` puts the category in the URL
// (`/showcase/kitchen-sink`) WITHOUT adding a nav level, exactly like `reference` mounts at `/api`.
const arrange_default = [
	{ label: 'Getting Started', items: getting_started, base: 'getting-started' },
	{ label: 'Concepts', items: concepts, base: 'concepts' },
	{ label: 'Guides', items: guides_cat, base: 'guides' },
	{ label: 'Showcase', items: showcase, base: 'showcase' },
	reference,
	github
];
// Thin corpora share one simple arrangement.
const arrange_thin = (g: typeof getting_started) => [
	{ label: 'Getting Started', items: g },
	reference,
	github
];

export const site = pharos({
	outline: dimensions({
		axes: {
			version: { values: ['v1', 'v2'], default: 'v2', label: 'Version' },
			locale: { values: ['en', 'hi'], default: 'en', fallback: true, label: 'Language' }
		},
		weave: ({ version, locale }) =>
			version === 'v1'
				? outline(arrange_thin(v1))
				: locale === 'hi'
					? outline(arrange_thin(hi))
					: outline(arrange_default)
	}),
	prevNext: 'graph'
});
