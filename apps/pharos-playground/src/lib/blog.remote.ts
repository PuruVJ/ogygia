/**
 * The blog wire layer. `postList` maps the collection's refs to the shape `<BlogList>` renders (data
 * only, no bodies). `postDoc` resolves one post's view and bakes its body into a region ticket for
 * `<BlogPost>`. The corpus stays in `blog.server.ts`; routes import only these.
 */
import { remotes } from 'ogygia/content/server';
import { withRemotes } from 'ogygia/content/server';
import { posts, blog } from './blog.server';

export const { page: postPage } = remotes(blog, { base: '/blog' });

export const postList = withRemotes(posts).list({
	map: (e) => ({
		href: `/blog/${e.id}`,
		title: (e.data.title as string) ?? e.id,
		date: (e.data.date as string) ?? '',
		summary: e.data.summary as string | undefined,
		author: e.data.author as string | undefined,
		tags: e.data.tags as string[] | undefined
	})
});
