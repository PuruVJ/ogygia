import { blog } from '$lib/site.server';
import { post_date } from '$lib/blog';

// The blog index — refs only (titles, descriptions, dates), newest first. Fully prerendered.
export const prerender = true;

export const load = async () => {
	const refs = await blog.refs();
	const posts = refs
		.map((r) => ({
			slug: r.id,
			title: r.data.title,
			description: r.data.description,
			date: post_date(r.filePath)
		}))
		.filter((p) => p.date)
		.sort((a, b) => (a.date! < b.date! ? 1 : -1));
	return { posts };
};
