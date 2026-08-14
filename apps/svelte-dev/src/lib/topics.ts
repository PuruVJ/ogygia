/**
 * Client-safe topic metadata — labels, hrefs, the path→topic mapping, and the doc data type.
 * The content engine (collections + pharos site) lives in `site.server.ts`, where Kit guarantees
 * no client code can reach it; components and islands import THIS freely.
 */
import * as v from 'valibot';

export const docSchema = v.object({ title: v.optional(v.string(), '') });
export type DocData = v.InferOutput<typeof docSchema>;

export type TopicKey = 'svelte' | 'kit' | 'cli' | 'ai';

export const TOPICS: Array<{ key: TopicKey; label: string; href: string }> = [
	{ key: 'svelte', label: 'Svelte', href: '/docs' },
	{ key: 'kit', label: 'SvelteKit', href: '/docs/kit' },
	{ key: 'cli', label: 'CLI', href: '/docs/cli' },
	{ key: 'ai', label: 'AI', href: '/docs/ai' }
];

/** The topic a `/docs` pathname belongs to (svelte is the bare default). */
export function topicFromPath(pathname: string): TopicKey {
	const seg = pathname.replace(/^\/docs\/?/, '').split('/')[0];
	return seg === 'kit' || seg === 'cli' || seg === 'ai' ? seg : 'svelte';
}
