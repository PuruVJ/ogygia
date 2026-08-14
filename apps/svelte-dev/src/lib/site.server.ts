/**
 * The content engine — collections (eager `git()` globs, the whole compiled corpus) and the pharos
 * site. A `.server.ts` module: Kit GUARANTEES no client code can import it (a build error names the
 * chain), so the corpus is mechanically un-leakable. The wire surface is minted in `docs.remote.ts` /
 * `blog.remote.ts`; server machinery (emissions, prerender entries, load guards) imports this directly.
 */
import { content, numbered, dated } from 'ogygia/content';
import { pharos, dimensions } from 'ogygia/pharos';
import * as v from 'valibot';
import type { TopicKey } from './topics';

const schema = v.object({ title: v.optional(v.string(), '') });

// One folder convention for the docs topics: numbered `.md` file-pages, `index.md` as the section
// label, duplicate prefixes allowed (the docs reuse them as group keys).
const folderOpts = {
	page: /\.md$/,
	meta: /(^|\/)index\.md$/,
	convention: numbered({ duplicates: 'allow' }),
};

const collections = {
	svelte: content({
		loader: import.meta.ogygia.loader.git('sveltejs/svelte@main:documentation/docs', folderOpts),
		schema,
	}),
	kit: content({
		loader: import.meta.ogygia.loader.git('sveltejs/kit@main:documentation/docs', folderOpts),
		schema,
	}),
	cli: content({
		loader: import.meta.ogygia.loader.git('sveltejs/cli@main:documentation/docs', folderOpts),
		schema,
	}),
	// svelte.dev's fourth topic — the AI/MCP tooling docs, from its own repo (same as their sync-docs).
	ai: content({
		loader: import.meta.ogygia.loader.git('sveltejs/ai-tools@main:documentation/docs', folderOpts),
		schema,
	}),
};

export const site = pharos({
	base: '/docs',
	outline: dimensions({
		axes: { topic: { values: ['svelte', 'kit', 'cli', 'ai'], default: 'svelte', label: 'Docs' } },
		weave: ({ topic }) => collections[topic as TopicKey],
	}),
	prevNext: 'graph',
});

// ── the blog — svelte.dev's actual posts, straight from their repo ──────────────
// A separate GENRE, not a docs dimension: flat corpus, `YYYY-MM-DD-slug.md` names (the `dated()`
// convention orders chronologically and keeps dates out of URLs), post-shaped frontmatter.

export const blogSchema = v.object({
	title: v.optional(v.string(), ''),
	description: v.optional(v.string(), ''),
	author: v.optional(v.string(), ''),
	authorURL: v.optional(v.string(), ''),
	draft: v.optional(v.boolean(), false),
});
export type BlogData = v.InferOutput<typeof blogSchema>;

export const blog = content({
	loader: import.meta.ogygia.loader.git('sveltejs/svelte.dev@main:apps/svelte.dev/content/blog', {
		// `page` strips ONLY the extension (the filename must survive as the id segment — folder()
		// removes the page match from the path); `index.md` is claimed by `meta` first. The `dated()`
		// convention then peels the date off each surviving filename.
		page: /\.md$/,
		meta: /(^|\/)index\.md$/,
		convention: dated(),
	}),
	schema: blogSchema,
	filter: (e) => !e.data.draft,
});
