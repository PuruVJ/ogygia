/**
 * Client-side search — a Web Worker over the prerendered `search.json`, so queries run on-device and
 * instantaneously (no network per keystroke, no server index build). This is the fast path the
 * `<Search>` brick and bespoke chrome (a custom sidebar) both use; the `remotes(site).search` remote
 * is the OTHER path, for dynamic sites where the corpus must stay server-side.
 *
 * Browser-only (instantiates a `Worker`). Build once (fetch + index), then `query()` is a worker
 * round-trip — sub-millisecond for docs-scale corpora.
 */
import type { SearchHit } from './search.js';

export type SearchClient = {
	/** Ranked hits for a query (empty string → []). */
	query(q: string): Promise<SearchHit[]>;
	/** Resolves once the index is fetched + built (rejects on load failure). */
	ready: Promise<void>;
	/** Terminate the worker. */
	destroy(): void;
};

export type SearchClientOptions = {
	/** Mount prefix — hit hrefs AND the index location derive from it (default `''`, root mount). */
	base?: string;
	/** Where the index is mounted. Convention: `{base}/search.json`. Override only if you mounted
	 *  `site.emit.search()` somewhere else. */
	endpoint?: string;
	/** Result cap (default 10). */
	limit?: number;
};

/**
 * The headless search handle for bespoke chrome — `const s = search({ base: '/docs' })`, then
 * `s.query(q)`. One argument, convention-first. (The `<Search>` brick uses this internally; inside a
 * `<Shell>` it needs no arguments at all.)
 */
export function search(opts: SearchClientOptions = {}): SearchClient {
	const base = (opts.base ?? '').replace(/\/+$/, '');
	const url = opts.endpoint ?? `${base}/search.json`;
	const worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
	let seq = 0;
	const pending = new Map<number, (hits: SearchHit[]) => void>();

	let ready_resolve!: () => void;
	let ready_reject!: (err: Error) => void;
	const ready = new Promise<void>((resolve, reject) => {
		ready_resolve = resolve;
		ready_reject = reject;
	});

	worker.onmessage = (e: MessageEvent) => {
		const m = e.data as { type: string; id?: number; hits?: SearchHit[]; message?: string };
		if (m.type === 'result' && m.id !== undefined) pending.get(m.id)?.(m.hits ?? []);
		else if (m.type === 'ready') ready_resolve();
		else if (m.type === 'error') ready_reject(new Error(m.message ?? 'search index failed to load'));
	};
	// A worker-level crash (module failed to load/parse) never sends a message — surface it so the
	// palette shows *why* instead of hanging on "loading" forever.
	worker.onerror = (e: ErrorEvent) => {
		ready_reject(new Error(e.message || `search worker failed to start (${url})`));
	};
	worker.postMessage({ type: 'load', url });

	return {
		ready,
		query(q) {
			if (!q.trim()) return Promise.resolve([]);
			const id = ++seq;
			return new Promise<SearchHit[]>((resolve) => {
				pending.set(id, (hits) => {
					pending.delete(id);
					resolve(hits);
				});
				worker.postMessage({ type: 'query', id, q, base, limit: opts.limit ?? 10 });
			});
		},
		destroy() {
			worker.terminate();
		}
	};
}
