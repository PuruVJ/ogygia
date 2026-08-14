import { error, redirect } from '@sveltejs/kit';
import type { EntryGenerator } from './$types';
import { site } from '$lib/site.server';
import { resolve_flat, flat_entries } from '$lib/flat-alias.server';

// Every leaf slug in the dimensioned outline (union across topics) PLUS the flat aliases — the
// aliases prerender as redirect stubs, so upstream-scheme links work even on static hosting.
export const prerender = true;
export const entries: EntryGenerator = async () => [
	...(await site.entries()),
	...(await flat_entries())
];

// 404 guard + topic-root redirects (`/docs`, `/docs/kit` → the topic's first page) + the FLAT
// alias scheme: the upstream corpus links pages without their section segment (svelte.dev's URL
// shape) — those 308 to the canonical address. Server-only; the page body itself renders in the
// component via the `doc` remote.
export const load = async ({ params }: { params: { slug: string } }) => {
	const slug = params.slug ?? '';
	if (slug && (await site.doc(slug, { base: '/docs' }))) return {};


	const prefix =
		slug === 'kit' || slug === 'cli' || slug === 'ai' ? `${slug}/` : slug === '' ? '' : null;
	if (prefix !== null) {
		const all = await site.entries();
		const first = prefix
			? all.find((e) => e.slug.startsWith(prefix))
			: all.find((e) => !/^(kit|cli|ai)\//.test(e.slug));
		if (first) redirect(307, `/docs/${first.slug}`);
	}
	// upstream flat scheme / wrong-section or cross-topic relative links → canonical, by topic+leaf.
	// Runs AFTER the topic-root handling above (else `/docs/kit` would self-redirect): by here the
	// slug is neither a real page nor a topic root, so a topic name in leaf position (`kit/svelte`
	// from their relative `../svelte`) means that topic's root, and anything else resolves by leaf.
	const flat = await resolve_flat(slug);
	if (flat && typeof flat === 'object') redirect(308, flat.root === 'svelte' ? '/docs' : `/docs/${flat.root}`);
	if (typeof flat === 'string') redirect(308, `/docs/${flat}`);
	error(404, 'Not found');
};
