/**
 * svelte.dev's FLAT address scheme, as an app-level alias layer. The upstream corpus links pages the
 * way svelte.dev serves them — `/docs/kit/routing`, `/docs/svelte/$state` — with no section segment,
 * and RELATIVE links (`[...]($props)`) that resolve against the current URL's directory, which under
 * our nested canonical scheme lands in the wrong section (`/docs/introduction/$props`).
 *
 * One rule subsumes every spelling: **a missed slug resolves by topic + LEAF.** Whatever the middle
 * segments say, if the last segment uniquely names a page in that topic, 308 to its canonical URL.
 * That covers their flat scheme, their `svelte/`-prefixed spellings of our bare default topic, and
 * wrong-section relative links in one lookup. Ambiguous leaves (two pages in one topic sharing a
 * name) are dropped with a warning — svelte.dev serves these corpora flat, so it cannot happen today.
 */
import { docs } from './site.server';

const TOPIC = /^(kit|cli|ai)\//;
const AMBIGUOUS = Symbol('ambiguous');

let index_p: Promise<Map<string, string | typeof AMBIGUOUS>> | null = null;

function leaf_index(): Promise<Map<string, string | typeof AMBIGUOUS>> {
	return (index_p ??= build());
}

async function build(): Promise<Map<string, string | typeof AMBIGUOUS>> {
	const map = new Map<string, string | typeof AMBIGUOUS>();
	for (const { slug } of await docs.entries()) {
		const m = TOPIC.exec(slug);
		const topic = m ? m[1]! : 'svelte'; // bare canonical = the svelte topic
		const rest = m ? slug.slice(topic.length + 1) : slug;
		const leaf = rest.split('/').pop()!;
		const key = `${topic}\0${leaf}`;
		const prev = map.get(key);
		if (prev !== undefined && prev !== slug) {
			if (prev !== AMBIGUOUS) console.warn(`[svelte-dev] leaf '${leaf}' is ambiguous in '${topic}' — flat links to it are dropped`);
			map.set(key, AMBIGUOUS);
			continue;
		}
		map.set(key, slug);
	}
	return map;
}

const TOPICS = new Set(['svelte', 'kit', 'cli', 'ai']);

/**
 * Resolve a MISSED slug. Returns the canonical slug, `{ root }` when the path denotes a topic root
 * (their `../svelte` from a nested kit page arrives as `kit/svelte`), or null.
 * Topic = the LAST topic-name segment anywhere in the path (cross-topic relative links leave the
 * old topic as a stale prefix: `kit/svelte/$state` means svelte's `$state`); leaf = last segment.
 */
export async function resolve_flat(
	slug: string
): Promise<string | { root: 'svelte' | 'kit' | 'cli' | 'ai' } | null> {
	const segments = slug.split('/').filter(Boolean);
	if (!segments.length) return null;
	const leaf = segments[segments.length - 1]!;
	// a topic name in leaf position = that topic's root
	if (TOPICS.has(leaf)) return { root: leaf as 'svelte' | 'kit' | 'cli' | 'ai' };
	let topic: string = 'svelte';
	for (const seg of segments.slice(0, -1)) if (TOPICS.has(seg)) topic = seg;
	const hit = (await leaf_index()).get(`${topic}\0${leaf}`);
	return typeof hit === 'string' && hit !== slug ? hit : null;
}

/** The FINITE their-scheme spellings (`<topic>/<leaf>`, `svelte/<leaf>`, bare `<leaf>`) — the
 *  prerender entries for redirect stubs, so direct visits work even on static hosting. */
export async function flat_entries(): Promise<Array<{ slug: string }>> {
	const out: Array<{ slug: string }> = [];
	for (const [key, canonical] of await leaf_index()) {
		if (typeof canonical !== 'string') continue;
		const [topic, leaf] = key.split('\0') as [string, string];
		const spelled = topic === 'svelte' ? [leaf, `svelte/${leaf}`] : [`${topic}/${leaf}`];
		for (const s of spelled) if (s !== canonical) out.push({ slug: s });
	}
	return out;
}
