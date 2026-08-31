/**
 * Search worker — builds the Orama index off the main thread and answers queries. Instantiated by
 * the `<Search>` brick via `new Worker(new URL('./search-worker.js', import.meta.url))`. Ingests the
 * prerendered `search.json` documents; the heavy engine (optional peer) is lazy-loaded inside.
 *
 * Messages in:  { type: 'load', url } | { type: 'query', id, q, base, limit }
 * Messages out: { type: 'ready' } | { type: 'error', message } | { type: 'result', id, hits }
 */
import { orama_engine, type SearchIndex } from './search.js';

let index_p: Promise<SearchIndex> | null = null;

self.onmessage = async (e: MessageEvent) => {
	const msg = e.data as {
		type: string;
		url?: string;
		id?: number;
		q?: string;
		base?: string;
		limit?: number;
	};

	if (msg.type === 'load' && msg.url) {
		index_p = (async () => {
			const res = await fetch(msg.url!);
			if (!res.ok) {
				throw new Error(
					`[ogygia/content] could not load the search index at ${msg.url} (HTTP ${res.status}). Did you mount site.emit.search()?`
				);
			}
			const docs = await res.json();
			const engine = orama_engine();
			await engine.init?.();
			return engine.build(docs);
		})();
		try {
			await index_p;
			(self as unknown as Worker).postMessage({ type: 'ready' });
		} catch (err) {
			(self as unknown as Worker).postMessage({
				type: 'error',
				message: err instanceof Error ? err.message : String(err)
			});
		}
		return;
	}

	if (msg.type === 'query' && index_p) {
		try {
			const index = await index_p;
			const hits = await index.query(msg.q ?? '', { limit: msg.limit ?? 10, base: msg.base ?? '' });
			(self as unknown as Worker).postMessage({ type: 'result', id: msg.id, hits });
		} catch (err) {
			(self as unknown as Worker).postMessage({
				type: 'error',
				message: err instanceof Error ? err.message : String(err)
			});
		}
	}
};
