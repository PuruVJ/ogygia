/**
 * The typed api() client, looped against the REAL router: the client's fetch is wired straight
 * into app.fetch, so every assertion crosses the full dispatch — pattern fill, query, JSON body,
 * schema 400s, finalize()'s plain-return serialization and 204-on-null.
 */
import { describe, it, expect } from 'vitest';
import { routes, GET, POST, api, ApiError, type StandardSchemaV1 } from '../src/router/index.js';

const Body: StandardSchemaV1<{ title: string }> = {
	'~standard': {
		version: 1,
		vendor: 't',
		validate: (v) => {
			const t = (v as { title?: unknown })?.title;
			return typeof t === 'string'
				? { value: { title: t } }
				: { issues: [{ message: 'title required', path: ['title'] }] };
		}
	}
};

const app = routes({
	'/posts/[id]': {
		GET: GET<'/posts/[id]'>((c) => ({ id: c.params.id, q: c.search.q ?? null }))
	},
	'/posts': { POST: POST(Body, (c) => ({ created: c.input.title })) },
	'/gone': { DELETE: () => null } // plain null → finalize's 204
});

const client = api<typeof app.$infer>('http://svc', {
	fetch: (async (url: string | URL | Request, init?: RequestInit) =>
		(await app.fetch(new Request(url as string, init)))!) as typeof fetch
});

describe('api() — the typed endpoint client', () => {
	it('fills the pattern, carries the query, parses the typed payload', async () => {
		const out = await client.get('/posts/[id]', { params: { id: '42' }, search: { q: 'x' } });
		expect(out).toEqual({ id: '42', q: 'x' });
	});

	it('POSTs the schema-typed body; the payload comes back typed', async () => {
		const out = await client.post('/posts', { body: { title: 'hello' } });
		expect(out).toEqual({ created: 'hello' });
	});

	it('a schema 400 throws ApiError carrying the issues body', async () => {
		const err = await client
			.post('/posts', { body: { title: 1 as never } })
			.then(() => null)
			.catch((e: ApiError) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err!.status).toBe(400);
		expect((err!.body as { issues: unknown[] }).issues).toHaveLength(1);
	});

	it('a null return answers 204 → resolves undefined', async () => {
		expect(await client.delete('/gone')).toBeUndefined();
	});

	it('an unmatched path throws ApiError 404', async () => {
		const bad = api<Record<'/nope', { get: { out: unknown; in: undefined } }>>('http://svc', {
			fetch: (async (url: string | URL | Request, init?: RequestInit) =>
				(await app.fetch(new Request(url as string, init))) ??
				new Response('Not found', { status: 404 })) as typeof fetch
		});
		const err = await bad.get('/nope').catch((e: ApiError) => e);
		expect((err as ApiError).status).toBe(404);
	});
});
