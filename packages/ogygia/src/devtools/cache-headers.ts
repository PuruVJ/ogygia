/**
 * HOW THE HOST CACHES THE ISLANDS' FILES. In a build every island's file and the runtime are named by
 * their content (the region's `src`, the runtime script's `src`), so the right cache for them is a
 * year-long `immutable` one — a new build names new files. A host that serves them `no-cache`, or
 * with a short `max-age`, makes every returning visitor download (or revalidate) every island again.
 * The browser's timing API does not expose response headers, so this asks the server once for each
 * file's (a HEAD request, past the cache) when the Page tab opens. Off a build (no `src`): nothing.
 */
import { all_regions, region_name } from './regions.js';
import type { StylesFinding } from './styles.js';

export interface CacheProbe {
	url: string;
	/** the island's name, or "the runtime" */
	name: string;
	cache_control: string | null;
	/** decoded bytes, when the browser loaded the file */
	bytes: number;
}

/** A day: a content-named file cached for less than this is fetched again on most return visits. */
const MIN_MAX_AGE_S = 86_400;

/** Read one `cache-control`: whether it caches the file long enough to count. Split, not a regex. */
export function cached_long(cache_control: string | null): boolean {
	if (!cache_control) return false;
	let max_age = -1;
	let immutable = false;
	for (const raw of cache_control.toLowerCase().split(',')) {
		const d = raw.trim();
		if (d === 'no-store' || d === 'no-cache') return false;
		if (d === 'immutable') immutable = true;
		if (d.startsWith('max-age=')) max_age = Number(d.slice('max-age='.length));
	}
	return immutable ? max_age !== 0 : max_age >= MIN_MAX_AGE_S;
}

/** Every content-named file the page loads (the islands' locations, the runtime's), each once. */
export function content_named_files(doc: Document = document): { url: string; name: string }[] {
	const out = new Map<string, string>();
	const abs = (u: string) => new URL(u, doc.baseURI).href;
	for (const r of all_regions()) {
		const src = r.el.getAttribute('src');
		if (src && r.entry && src !== r.entry && !out.has(abs(src))) out.set(abs(src), region_name(r.entry));
	}
	const rt = doc.querySelector('script[data-ogygia-runtime]')?.getAttribute('src');
	if (rt && !out.has(abs(rt))) out.set(abs(rt), 'the runtime');
	return [...out].map(([url, name]) => ({ url, name }));
}

/** Ask the server how it caches each file (HEAD, past the browser's cache), at most `limit` files. */
export async function probe_cache(doc: Document = document, limit = 40): Promise<CacheProbe[]> {
	const sizes = new Map<string, number>();
	for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) sizes.set(r.name, r.decodedBodySize || 0);
	const files = content_named_files(doc).slice(0, limit);
	return Promise.all(
		files.map(async ({ url, name }) => {
			let cache_control: string | null = null;
			try {
				const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
				cache_control = res.headers.get('cache-control');
			} catch {
				cache_control = null;
			}
			return { url, name, cache_control, bytes: sizes.get(url) ?? 0 };
		})
	);
}

/** The finding: content-named files the host does not cache long, named, with the bytes at stake. */
export function cache_findings(probes: readonly CacheProbe[]): StylesFinding[] {
	const short = probes.filter((p) => !cached_long(p.cache_control));
	if (!short.length) return [];
	const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
	const bytes = short.reduce((s, p) => s + p.bytes, 0);
	// the headers seen, each once (a host sends one policy for the whole directory, usually)
	const seen = [...new Set(short.map((p) => p.cache_control ?? 'no cache-control'))].slice(0, 3);
	// the heaviest first: the names that fit are the files a return visit pays most for
	const names = [...new Set([...short].sort((a, b) => b.bytes - a.bytes).map((p) => p.name))];
	const list = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
	return [
		{
			code: 'island-files-uncached',
			severity: 'warn',
			message: `${short.length} of the page's content-named files (${list}) are served with \`${seen.join('`, `')}\`: a returning visitor downloads${bytes ? ` ${kb(bytes)}` : ''} again (or waits to revalidate) on every visit. Their names change with their content, so they can be cached for good.`,
			fix: "Serve `_app/immutable/` with `cache-control: public, max-age=31536000, immutable` (SvelteKit's adapters do; a proxy, a CDN rule or a custom server in front can override it)."
		}
	];
}
