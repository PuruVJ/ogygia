/**
 * Router v2 Standard Schema validation — the three clean input surfaces: body (POST/PUT/PATCH verb
 * schema → `c.input`), and (through an endpoint that echoes) that path stays on `c.params`, query on
 * `c.search`. Page-level `params`/`search` schemas coerce + gate (404 / 400); here we exercise the
 * runtime dispatch of the body schema + a manual params/search validate via an endpoint.
 */
import { describe, it, expect } from 'vitest';
import { routes, page, POST } from '../src/router/index.js';
import type { Component } from 'svelte';
import type { StandardSchemaV1 } from '../src/router/view.js';

const req = (path: string, init?: RequestInit) => new Request('http://x' + path, init);

/** `{ n: number }` coerced — body values arrive parsed; a bad `n` yields issues. */
const NumBody: StandardSchemaV1<{ n: number }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			const n = Number((value as Record<string, unknown>)?.n);
			if (!Number.isFinite(n)) return { issues: [{ message: 'n must be a number', path: ['n'] }] };
			return { value: { n } };
		}
	}
};

describe('endpoint body schema (POST/PUT/PATCH → c.input)', () => {
	const app = routes({
		'/sum': { POST: POST(NumBody, (c) => c.json({ plus1: c.input.n + 1 })) },
		'/echo': { GET: (c) => c.json({ params: c.params, search: c.search }) }
	});

	it('validates the JSON body and types c.input', async () => {
		const r = await app.fetch(
			req('/sum', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ n: 4 })
			})
		);
		expect(await r!.json()).toEqual({ plus1: 5 });
	});

	it('400s a bad body with the issues', async () => {
		const r = await app.fetch(
			req('/sum', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ n: 'x' })
			})
		);
		expect(r!.status).toBe(400);
		expect((await r!.json()).issues[0].message).toMatch(/must be a number/);
	});

	it('400s a non-JSON body', async () => {
		const r = await app.fetch(req('/sum', { method: 'POST', body: 'not json' }));
		expect(r!.status).toBe(400);
	});

	it('GET has no body schema — path on c.params, query on c.search (three clean surfaces)', async () => {
		const r = await (await app.fetch(req('/echo?q=hi&n=2')))!.json();
		expect(r.search).toEqual({ q: 'hi', n: '2' });
		expect(r.params).toEqual({});
	});
});

/** A page-level `search` schema: coerce + gate. `?page=x` → 400 with issues; absent → the schema's own
 *  default (lenient); present → coerced. Observed through a load that RETURNS a Response — render_page
 *  short-circuits on it before any component render, so no Svelte render is needed here. */
const PageQ: StandardSchemaV1<{ page: number }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			const raw = (value as Record<string, unknown>)?.page;
			if (raw === undefined) return { value: { page: 1 } }; // lenient default
			const page = Number(raw);
			if (!Number.isInteger(page) || page < 1)
				return { issues: [{ message: 'page must be a positive integer', path: ['page'] }] };
			return { value: { page } };
		}
	}
};

describe('page-level search schema (typed search params → c.search, bad → 400)', () => {
	const C = (() => {}) as unknown as Component<Record<string, unknown>>;
	const app = routes({
		'/list': page(C, { search: PageQ, load: async (c) => c.json({ search: c.search }) })
	});

	it('coerces good input into the typed c.search (string → number)', async () => {
		const r = await app.fetch(req('/list?page=3'));
		expect(r!.status).toBe(200);
		expect(await r!.json()).toEqual({ search: { page: 3 } });
	});

	it('applies the schema default when the param is absent (lenient)', async () => {
		const r = await app.fetch(req('/list'));
		expect(await r!.json()).toEqual({ search: { page: 1 } });
	});

	it('400s bad input with the issues, before any load runs', async () => {
		const r = await app.fetch(req('/list?page=abc'));
		expect(r!.status).toBe(400);
		const body = await r!.json();
		expect(body.error).toBe('Invalid query');
		expect(body.issues[0].path).toEqual(['page']);
	});
});
