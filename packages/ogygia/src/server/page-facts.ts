/**
 * PAGE FACTS — the page a render outside its page belongs to (internal/notes/region-page-context.md).
 *
 * A hole renders in the islands endpoint's request, a region refreshed by a remote `query` /
 * `command` in the remote call's: no page render around them, so no `page.data`. Their page is the
 * same-origin `Referer`, and its data is looked up through Kit itself — the data request Kit's own
 * client makes on a navigation (`<page>/__data.json`). The app's handle chain and the page's server
 * loads run with the visitor's cookies: the facts are the server's, for this visitor, now; nothing
 * the browser could forge or that a cache could have kept from someone else.
 *
 * Cheap by construction: the caller looks up only when a render reads `page.data`, once per request;
 * only the answer's FIRST line is waited for (a streamed promise in the data resolves later, in the
 * background, without holding the render); no regex.
 */
import * as devalue from 'devalue';

/** Marks ogygia's own lookup: the handle answers it without setting up a page render. */
export const PAGE_FACTS_HEADER = 'x-ogygia-page-facts';
/** The route id and params Kit matched for the looked-up page (the data alone carries neither). */
export const PAGE_FACTS_ROUTE_HEADER = 'x-ogygia-page-route';

export type PageFacts = {
	url: URL;
	params: Record<string, string | undefined>;
	route: { id: string | null };
	data: Record<string, unknown>;
};

type Decoders = Record<string, (value: unknown) => unknown>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Deferred = { fulfil: (v: unknown) => void; reject: (e: unknown) => void };

/** Kit's data URL for a page, as its client builds it: the data suffix on the path, the page's
 *  search kept, the trailing-slash marker when the path ends in `/`. */
export function data_url_of(page: URL): string {
	const u = new URL(page.href);
	u.hash = '';
	const p = page.pathname;
	u.pathname = p.endsWith('.html') ? p.slice(0, -5) + '.html__data.json' : (p.endsWith('/') ? p.slice(0, -1) : p) + '/__data.json';
	if (p.endsWith('/')) u.searchParams.append('x-sveltekit-trailing-slash', '1');
	return u.href;
}

/**
 * The page's facts, or a reason they are not available (a redirect, an error, a load that threw,
 * not a Kit data answer). `decoders`: the app's `transport` decoders, as Kit's client uses them.
 */
export async function look_up_page(page: URL, fetch: Fetch, decoders: Decoders): Promise<PageFacts | { miss: string }> {
	let res: Response;
	try {
		res = await fetch(data_url_of(page), { headers: { [PAGE_FACTS_HEADER]: '1' } });
	} catch (e) {
		return { miss: `the data request failed (${String((e as Error)?.message ?? e)})` };
	}
	if (!res.ok || !res.body) {
		void res.body?.cancel().catch(() => {});
		return { miss: `the data request answered ${res.status}` };
	}
	const reader = res.body.getReader();
	const text = new TextDecoder();
	let buf = '';
	let nl = -1;
	while ((nl = buf.indexOf('\n')) === -1) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += text.decode(value, { stream: true });
	}
	const first = nl === -1 ? buf : buf.slice(0, nl);
	const rest = nl === -1 ? '' : buf.slice(nl + 1);
	const stop = (miss: string) => {
		void reader.cancel().catch(() => {});
		return { miss };
	};
	let head: { type?: string; nodes?: unknown[]; location?: string };
	try {
		head = JSON.parse(first);
	} catch {
		return stop('the answer is not Kit data');
	}
	if (head?.type === 'redirect') return stop(`a load redirected to ${head.location}`);
	if (head?.type !== 'data' || !Array.isArray(head.nodes)) return stop('the answer is not Kit data');

	const deferreds = new Map<number, Deferred>();
	const revive = (flat: unknown) =>
		devalue.unflatten(flat as number, {
			...decoders,
			Promise: (id: number) => {
				const p = new Promise((fulfil, reject) => deferreds.set(id, { fulfil, reject }));
				p.catch(() => {}); // a rejected stream the render never awaited must not crash the process
				return p;
			}
		});
	const data: Record<string, unknown> = {};
	try {
		for (const node of head.nodes as ({ type?: string; data?: unknown } | null)[]) {
			if (node?.type === 'error') return stop('a load threw');
			if (node?.type === 'data') Object.assign(data, revive(node.data));
		}
	} catch (e) {
		return stop(`its data did not decode (${String((e as Error)?.message ?? e)})`);
	}
	if (deferreds.size) void settle_streamed(reader, text, rest, deferreds, revive);
	else void reader.cancel().catch(() => {});

	let route: { id: string | null } = { id: null };
	let params: Record<string, string | undefined> = {};
	const named = res.headers.get(PAGE_FACTS_ROUTE_HEADER);
	if (named) {
		try {
			const r = JSON.parse(decodeURIComponent(named)) as { id?: string | null; params?: Record<string, string> };
			route = { id: r.id ?? null };
			params = r.params ?? {};
		} catch {
			/* a mangled header: the page keeps no route */
		}
	}
	return { url: page, params, route, data };
}

/** The streamed promises in the page's data, fulfilled as their lines arrive (Kit's `chunk` lines). */
async function settle_streamed(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	text: TextDecoder,
	buf: string,
	deferreds: Map<number, Deferred>,
	revive: (flat: unknown) => unknown
): Promise<void> {
	const line = (raw: string) => {
		if (!raw) return;
		try {
			const chunk = JSON.parse(raw) as { type?: string; id?: number; data?: unknown; error?: unknown };
			if (chunk.type !== 'chunk' || chunk.id === undefined) return;
			const d = deferreds.get(chunk.id);
			if (!d) return;
			deferreds.delete(chunk.id);
			if (chunk.error !== undefined) d.reject(revive(chunk.error));
			else d.fulfil(revive(chunk.data));
		} catch {
			/* a line that does not decode leaves its promise pending */
		}
	};
	try {
		for (;;) {
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				line(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
			if (!deferreds.size) break;
			const { done, value } = await reader.read();
			if (done) break;
			buf += text.decode(value, { stream: true });
		}
		line(buf);
	} catch {
		/* the stream broke: what did not arrive stays pending */
	} finally {
		void reader.cancel().catch(() => {});
	}
}
