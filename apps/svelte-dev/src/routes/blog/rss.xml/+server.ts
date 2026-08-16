import { site, blog } from '$lib/site.server';
import { post_date } from '$lib/blog';

// The blog's feed — ogygia's RSS emission, `site.emit` style. Prerendered.
export const prerender = true;

export const GET = site.emit.rss({
	title: 'Svelte blog',
	description: 'Articles about Svelte and UI development',
	base: '/blog',
	items: async () =>
		(await blog.refs())
			.map((r) => ({
				href: `/blog/${r.id}`,
				title: r.data.title,
				description: r.data.description,
				date: post_date(r.filePath)!
			}))
			.filter((p) => p.date)
});
