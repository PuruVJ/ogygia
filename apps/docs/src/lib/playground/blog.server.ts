/**
 * The blog GENRE — a separate, flat, dated corpus (not a docs dimension). `fields.post` layers the
 * post extras (date/author/tags) over the page base (title/summary); `dated()` peels the date off
 * each `YYYY-MM-DD-slug.md` filename and orders newest-first. Server-only: the wire layer is
 * `blog.remote.ts`. `blog` gives us `doc()` (a post's view + prev/next) for `<BlogPost>`.
 */
import { content, dated } from 'ogygia/content';
import { site, outline, fields } from 'ogygia/content';

export const posts = content({
	// The whole playground corpus — blog included — compiles through the `playground` content
	// preset (overrides on), keeping this sub-app's rendering sovereign from the docs default.
	loader: import.meta.og.loader.folder('../../content/playground/blog/**/*.md', {
		preset: 'playground',
		page: /\.md$/,
		meta: /(^|\/)index\.md$/,
		convention: dated()
	}),
	schema: fields.post
});

// A one-collection ogygia site over the blog — for `page()` (post view with prev/next by date).
export const blog = site({ outline: outline(posts), prevNext: 'order' });
