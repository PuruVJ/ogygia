import { blog } from '$lib/blog.server';

export const prerender = true;
export const load = blog.load;
export const entries = blog.entries;
