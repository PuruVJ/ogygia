import { site } from '$lib/docs';

// A sitemap over every doc page — off the outline's leaves. Prerendered; canonical origin.
export const prerender = true;

export const GET = site.emit.sitemap({ base: '/docs', origin: 'https://ogygia.puruvj.dev' });
