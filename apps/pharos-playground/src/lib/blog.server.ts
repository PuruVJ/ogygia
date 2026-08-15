/**
 * The blog GENRE — a separate, flat, dated corpus (not a docs dimension). `fields.post` layers the
 * post extras (date/author/tags) over the page base (title/summary); `dated()` peels the date off
 * each `YYYY-MM-DD-slug.md` filename and orders newest-first. Server-only: the wire layer is
 * `blog.remote.ts`. `blogSite` gives us `doc()` (a post's view + prev/next) for `<BlogPost>`.
 */
import { content, dated } from 'ogygia/content';
import { pharos, outline, fields } from 'ogygia/pharos';

export const blog = content({
	loader: import.meta.og.loader.folder('../content/blog/**/*.md', {
		page: /\.md$/,
		meta: /(^|\/)index\.md$/,
		convention: dated()
	}),
	schema: fields.post
});

// A one-collection pharos site over the blog — for `doc()` (post view with prev/next by date).
export const blogSite = pharos({ outline: outline(blog), prevNext: 'order' });
