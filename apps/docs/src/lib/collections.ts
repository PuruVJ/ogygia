/**
 * Docs content collection — dogfoods `ogygia/content`.
 *
 * Each page is a folder: `NN-section/NN-page/+doc.svx`, with the page's demo components colocated
 * beside it. Order + section come from the `NN-` folder prefixes; `generateId` strips them so URLs
 * stay clean (`/docs/start/install`). The sidebar reads the prefixes off `filePath` (see
 * `parseDocPath`). Frontmatter is just `title` / `summary` / `draft`.
 *
 * ONE definition: `content()` is browser-safe (get / ids / entries + relations), so a csr=false
 * route can call `get()` without dragging `$app/server` into the graph. The `docNav` remote is
 * minted by wrapping this same `docs` with `withRemotes()` in `docs.remote.ts` (server-only).
 */
import { content, markdown } from 'ogygia/content';
import * as v from 'valibot';

const docSchema = v.object({
	title: v.string(),
	summary: v.optional(v.string(), ''),
	draft: v.optional(v.boolean(), false),
	// "Keep reading" links, by slug (e.g. 'islands/server-islands'). Resolved through the content
	// graph's self `related` relation into `entry.rel.related` (title + summary come along).
	related: v.optional(v.array(v.string()), [])
});

export type DocData = v.InferOutput<typeof docSchema>;

/** `…/00-start/01-install/+doc.svx` → clean slug `start/install` (drop `+doc.svx` + `NN-`). */
function docId(key: string): string {
	return key
		.replace(/\\/g, '/')
		.replace(/.*content\/docs\//, '')
		.replace(/\/\+doc\.svx$/, '')
		.split('/')
		.map((seg) => seg.replace(/^\d+-/, ''))
		.join('/');
}

/**
 * The ONE definition — browser-safe. Import in routes/components; wrap with `withRemotes()` in a
 * `.remote.ts`. The explicit `ContentHandle<DocData>` annotation is required because the `related`
 * self-relation getter references `docs` (a cycle) — without it `docs` infers `any`.
 */
// Fully inferred: `Data` from `docSchema`, `Meta` ({ headings }) from `markdown`. No annotation.
export const docs = content({
	// The source IS the format now: markdown wraps the glob, `id` gives the clean slugs.
	loader: markdown(import.meta.glob('../content/docs/**/+doc.svx', { eager: true }), { id: docId }),
	schema: docSchema,
	// Self relation via `self` — a doc's `related` slugs resolve to sibling docs, no type cycle.
	relations: (self) => ({ related: self }),
	// Drafts are invisible everywhere — nav, prerender entries, and direct URL via get().
	filter: (e) => !e.data.draft
});
