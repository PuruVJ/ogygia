import { blogSite } from '$lib/blog.server';

export const prerender = true;
export const load = blogSite.load;
export const entries = blogSite.entries;
