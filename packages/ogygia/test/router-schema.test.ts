import { describe, it, expect } from 'vitest';
import { routes } from '../src/router/router.js';
import type { StandardSchemaV1 } from '../src/router/view.js';

const req = (path: string, init?: RequestInit) => new Request('http://x' + path, init);

// A tiny hand-rolled Standard Schema — `{ n: number }` coerced from strings (search/path are strings).
const NumInput: StandardSchemaV1<{ n: number }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			const v = value as Record<string, unknown>;
			const n = Number(v?.n);
			if (!Number.isFinite(n)) return { issues: [{ message: 'n must be a number', path: ['n'] }] };
			return { value: { n } };
		}
	}
};

describe('router — schema gate on endpoints', () => {
	const app = routes((r) =>
		r.routes({
			'/double/[n]': (r) => r.GET(NumInput, (c) => c.json({ doubled: c.input.n * 2 })),
			'/sum': (r) => r.POST(NumInput, (c) => c.json({ plus1: c.input.n + 1 }))
		})
	);

	it('validates path params and types c.input', async () => {
		expect(await (await app.fetch(req('/double/21')))!.json()).toEqual({ doubled: 42 });
	});

	it('400s on invalid input, handler never runs', async () => {
		const bad = await app.fetch(req('/double/abc'));
		expect(bad!.status).toBe(400);
		const body = await bad!.json();
		expect(body.error).toBe('Invalid input');
		expect(body.issues[0].message).toContain('number');
	});

	it('merges JSON body for a POST and validates it', async () => {
		const r = await app.fetch(
			req('/sum', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ n: 9 })
			})
		);
		expect(await r!.json()).toEqual({ plus1: 10 });
	});

	it('search params feed the schema too', async () => {
		expect(await (await app.fetch(req('/sum?n=4', { method: 'POST' })))!.json()).toEqual({ plus1: 5 });
	});
});
