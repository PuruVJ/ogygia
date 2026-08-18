import { docs } from '$lib/docs.server';

// A sitemap over every doc page — off the outline's leaves. Prerendered; canonical origin.
export const prerender = true;

export const GET = docs.emit.sitemap({ base: '/docs', origin: 'https://ogygia.puruvj.dev' });
