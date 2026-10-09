/**
 * THE PAGE OF A RENDER (server/render-page.ts, server/page-facts.ts): a render outside its page — a
 * hole in the islands endpoint's request, a region a remote call renders — sees the page it renders
 * for: the same-origin Referer's url, and its route, params and `page.data` from Kit's data request.
 *
 * REGRESSION (field report on 6b927c3c): a header a remote `query` rendered came out signed out,
 * wrong locale, wrong path — `page.data` was `{}`, `page.url` the remote endpoint's.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as devalue from 'devalue';
import type { RequestEvent } from '@sveltejs/kit';
import { data_url_of, look_up_page, PAGE_FACTS_HEADER, PAGE_FACTS_ROUTE_HEADER } from '../src/server/page-facts.js';
import { configure_render_page, page_url_of, prepare_render_page, render_page, renders_for_a_page } from '../src/server/render-page.js';

/** Kit's data answer: one `data` line (each node devalue-flattened), then a `chunk` line per promise. */
function kit_data(nodes: (Record<string, unknown> | null)[], chunks: string[] = []): string {
	const line = JSON.stringify({
		type: 'data',
		nodes: nodes.map((d) => (d === null ? null : { type: 'data', data: JSON.parse(devalue.stringify(d, { Promise: (v: unknown) => (v instanceof Promise ? 1 : undefined) })), uses: {} }))
	});
	return [line, ...chunks].join('\n') + '\n';
}

const answer = (body: string, headers: Record<string, string> = {}, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/sveltekit-data', ...headers } });

function event_of(o: { url: string; referer?: string; remote?: boolean; fetch?: RequestEvent['fetch'] }): RequestEvent {
	const headers = new Headers(o.referer ? { referer: o.referer } : {});
	return {
		url: new URL(o.url),
		request: new Request(o.url, { headers }),
		params: {},
		route: { id: null },
		isRemoteRequest: !!o.remote,
		fetch: o.fetch ?? (async () => answer('')),
		cookies: { get: () => undefined }
	} as unknown as RequestEvent;
}

beforeEach(() => configure_render_page({ endpoint_path: '/__ogygia__', warn: null }));

describe('data_url_of: the URL Kit’s client asks for a page’s data', () => {
	it('suffixes the path, keeps the search, marks a trailing slash', () => {
		expect(data_url_of(new URL('https://a.test/us/en/work?x=1#h'))).toBe('https://a.test/us/en/work/__data.json?x=1');
		expect(data_url_of(new URL('https://a.test/us/en/'))).toBe('https://a.test/us/en/__data.json?x-sveltekit-trailing-slash=1');
		expect(data_url_of(new URL('https://a.test/'))).toBe('https://a.test/__data.json?x-sveltekit-trailing-slash=1');
		expect(data_url_of(new URL('https://a.test/page.html'))).toBe('https://a.test/page.html__data.json');
	});
});

describe('look_up_page: Kit’s data answer, decoded like its client does', () => {
	it('merges every node’s data, reads the route header, marks its own request', async () => {
		let asked: RequestInit | undefined;
		const facts = await look_up_page(
			new URL('https://a.test/p/alpha'),
			async (_u, init) => {
				asked = init;
				return answer(kit_data([{ signedIn: true, locale: 'fr' }, { slug: 'alpha' }]), {
					[PAGE_FACTS_ROUTE_HEADER]: encodeURIComponent(JSON.stringify({ id: '/p/[slug]', params: { slug: 'alpha' } }))
				});
			},
			{}
		);
		expect(new Headers(asked?.headers).get(PAGE_FACTS_HEADER)).toBe('1');
		expect(facts).toEqual({ url: new URL('https://a.test/p/alpha'), route: { id: '/p/[slug]' }, params: { slug: 'alpha' }, data: { signedIn: true, locale: 'fr', slug: 'alpha' } });
	});

	it('decodes the app’s transport types', async () => {
		class Money {
			constructor(public cents: number) {}
		}
		const flat = JSON.parse(devalue.stringify({ price: new Money(250) }, { Money: (v: unknown) => v instanceof Money && v.cents }));
		const body = JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: flat }] }) + '\n';
		const facts = await look_up_page(new URL('https://a.test/x'), async () => answer(body), { Money: (c) => new Money(c as number) });
		expect('data' in facts && (facts.data.price as Money).cents).toBe(250);
	});

	it('returns at the first line: a streamed promise resolves later, without holding the render', async () => {
		let push!: (s: string) => void;
		let close!: () => void;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				push = (s) => c.enqueue(enc.encode(s));
				close = () => c.close();
			}
		});
		// a node whose `slow` key is a Promise (devalue's reducer form: ["Promise", <its id>], id 1)
		const flat = [{ slow: 1, n: 2 }, ['Promise', 3], 7, 1];
		push(JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: flat }] }) + '\n');
		const facts = await look_up_page(new URL('https://a.test/x'), async () => new Response(stream), {});
		expect('data' in facts).toBe(true);
		const data = (facts as { data: { slow: Promise<unknown>; n: number } }).data;
		expect(data.n).toBe(7);
		push(JSON.stringify({ type: 'chunk', id: 1, data: JSON.parse(devalue.stringify('later')) }) + '\n');
		close();
		await expect(data.slow).resolves.toBe('later');
	});

	it('a redirect, an error node, a failed request: a reason, never a guess', async () => {
		const at = new URL('https://a.test/x');
		expect(await look_up_page(at, async () => answer(JSON.stringify({ type: 'redirect', location: '/login' }) + '\n'), {})).toEqual({ miss: 'a load redirected to /login' });
		expect(await look_up_page(at, async () => answer(JSON.stringify({ type: 'data', nodes: [{ type: 'error', error: {} }] }) + '\n'), {})).toEqual({ miss: 'a load threw' });
		expect(await look_up_page(at, async () => answer('nope', {}, 500), {})).toEqual({ miss: 'the data request answered 500' });
		expect(await look_up_page(at, async () => answer('<!doctype html>'), {})).toEqual({ miss: 'the answer is not Kit data' });
	});
});

describe('render_page: one model, three venues', () => {
	it('in the page: the recorded snapshot, the live event filling the rest', () => {
		const event = event_of({ url: 'https://a.test/p/alpha' });
		const page = render_page({ data: { a: 1 } }, event)!;
		expect(page.data).toEqual({ a: 1 });
		expect(page.url?.href).toBe('https://a.test/p/alpha');
	});

	it('its own: no Referer rule outside the islands endpoint and remote calls', () => {
		const event = event_of({ url: 'https://a.test/api/thing', referer: 'https://a.test/p/alpha' });
		expect(renders_for_a_page(event)).toBe(false);
		expect(page_url_of(event).href).toBe('https://a.test/api/thing');
	});

	it('for a page (a remote call): the Referer’s page, its facts once looked up', async () => {
		let calls = 0;
		const event = event_of({
			url: 'https://a.test/_app/remote/abc/header',
			referer: 'https://a.test/p/alpha',
			remote: true,
			fetch: (async () => {
				calls++;
				return answer(kit_data([{ signedIn: true }]), { [PAGE_FACTS_ROUTE_HEADER]: encodeURIComponent(JSON.stringify({ id: '/p/[slug]', params: { slug: 'alpha' } })) });
			}) as RequestEvent['fetch']
		});
		// a bag-like snapshot in this request changes nothing: the venue is the request's kind
		expect(render_page({}, event)!.url?.href).toBe('https://a.test/p/alpha');
		await prepare_render_page(event, undefined, null);
		await prepare_render_page(event, undefined, null);
		expect(calls).toBe(1);
		const page = render_page({}, event)!;
		expect(page.data).toEqual({ signedIn: true });
		expect(page.route).toEqual({ id: '/p/[slug]' });
		expect(page.params).toEqual({ slug: 'alpha' });
	});

	it('dev: a key the server loads did not produce is named once (a universal load’s), never silent', async () => {
		const said: string[] = [];
		configure_render_page({ endpoint_path: '/__ogygia__', warn: (m) => said.push(m) });
		const event = event_of({
			url: 'https://a.test/_app/remote/abc/header',
			referer: 'https://a.test/p',
			remote: true,
			fetch: (async () => answer(kit_data([{ signedIn: true }]))) as RequestEvent['fetch']
		});
		await prepare_render_page(event, undefined, null);
		const data = render_page(undefined, event)!.data as Record<string, unknown>;
		expect(data.signedIn).toBe(true);
		expect(data.headerLocale).toBeUndefined();
		void data.headerLocale;
		void (data as { then?: unknown }).then;
		expect('headerLocale' in data).toBe(false);
		expect(said).toHaveLength(1);
		expect(said[0]).toContain('page.data.headerLocale');
	});

	it('a hole looks up only when its tree reads page.data; a cross-origin Referer never', async () => {
		let calls = 0;
		const fetch = (async () => {
			calls++;
			return answer(kit_data([{ x: 1 }]));
		}) as RequestEvent['fetch'];
		const hole = event_of({ url: 'https://a.test/__ogygia__?id=1', referer: 'https://a.test/p', fetch });
		await prepare_render_page(hole, undefined, false);
		await prepare_render_page(hole, undefined, null);
		expect(calls).toBe(0);
		await prepare_render_page(hole, undefined, true);
		expect(calls).toBe(1);
		const foreign = event_of({ url: 'https://a.test/__ogygia__?id=1', referer: 'https://evil.test/p', fetch });
		await prepare_render_page(foreign, undefined, true);
		expect(calls).toBe(1);
		expect(render_page(undefined, foreign)!.url?.href).toBe('https://a.test/__ogygia__?id=1');
	});
});
