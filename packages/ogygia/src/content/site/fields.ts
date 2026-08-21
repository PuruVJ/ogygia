/**
 * `fields` — the blessed frontmatter schema family. `fields.page` validates EXACTLY what the ogygia
 * brains read off a doc (title, summary, draft, badge, redirect_from, related) and nothing more. A
 * GENRE is a pre-layered stack over `content()`'s schema-array feature — no new machinery:
 *
 * ```ts
 * content({ loader, schema: fields.page })                       // docs
 * content({ loader, schema: [fields.page, v.object({ author: v.string() })] })   // + your extras
 * content({ loader, schema: fields.post })                       // the blog genre stack
 * ```
 *
 * Hand-written Standard Schema (the `string_arg` precedent in `server.ts`) so ogygia pulls no
 * valibot/zod dependency. Each returns `{ value }` or `{ issues }`.
 */
import type { SchemaLike } from '../index.js';

/** What every ogygia surface reads off a page. `title` is required; the rest carry blessed defaults. */
export type PageFields = {
	title: string;
	summary: string;
	draft: boolean;
	badge?: string;
	redirect_from?: string | string[];
	related: string[];
};

const is_str = (v: unknown): v is string => typeof v === 'string';
const str_array = (v: unknown): string[] => (Array.isArray(v) ? v.filter(is_str) : []);

/** A tiny Standard Schema from a pure `(data) => value | throw`. Keeps the family dependency-free. */
function schema<Out>(
	vendor: string,
	run: (data: Record<string, unknown>) => Out
): SchemaLike & { readonly ['~standard']: { types?: { output: Out } } } {
	return {
		['~standard']: {
			version: 1 as const,
			vendor,
			validate(value: unknown) {
				const data = (value ?? {}) as Record<string, unknown>;
				try {
					return { value: run(data) };
				} catch (e) {
					return { issues: [{ message: e instanceof Error ? e.message : String(e) }] };
				}
			}
		}
	} as SchemaLike & { readonly ['~standard']: { types?: { output: Out } } };
}

const page = schema<PageFields>('ogygia-content/page', (d) => {
	if (!is_str(d.title) || !d.title) throw new Error('frontmatter needs a non-empty `title`');
	const out: PageFields = {
		title: d.title,
		summary: is_str(d.summary) ? d.summary : '',
		draft: d.draft === true,
		related: str_array(d.related)
	};
	if (is_str(d.badge)) out.badge = d.badge;
	if (is_str(d.redirect_from) || Array.isArray(d.redirect_from)) {
		out.redirect_from = is_str(d.redirect_from) ? d.redirect_from : str_array(d.redirect_from);
	}
	return out;
});

/** Extra fields a blog post carries beyond a page (a Blog shell reads these; the brains do not). */
export type PostFields = { date: string; author?: string; tags: string[] };

/** A post as the blog INDEX lists it (`<BlogList posts>`): the display fields + its href. Map a
 *  collection's refs to this over the wire so the corpus stays server-side. */
export type BlogPostRef = {
	href: string;
	title: string;
	date: string;
	summary?: string;
	author?: string;
	tags?: string[];
};
const post_only = schema<PostFields>('ogygia-content/post', (d) => {
	if (!is_str(d.date) || !d.date) throw new Error('a post needs a `date`');
	const out: PostFields = { date: d.date, tags: str_array(d.tags) };
	if (is_str(d.author)) out.author = d.author;
	return out;
});

/** Extra fields a changelog entry carries beyond a page. */
export type ChangeFields = { version: string; date: string };
const change_only = schema<ChangeFields>('ogygia-content/change', (d) => {
	if (!is_str(d.version) || !d.version) throw new Error('a changelog entry needs a `version`');
	if (!is_str(d.date) || !d.date) throw new Error('a changelog entry needs a `date`');
	return { version: d.version, date: d.date };
});

/**
 * The blessed schema family. `page` is the universal base; `post` / `change` are pre-layered genre
 * stacks (base + genre extras) consumed by `content({ schema })`, which merges array layers left→right.
 */
export const fields = {
	page,
	post: [page, post_only] as [typeof page, typeof post_only],
	change: [page, change_only] as [typeof page, typeof change_only]
};
