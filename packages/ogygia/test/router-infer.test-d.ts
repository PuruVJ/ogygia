/* Type-level guard for router v2 `$infer` — merged cascade data (Kit's rule), schema-coerced params,
 * typed search, action-return form, and layout keys `App['(name)']`. tsc-only (no runtime). */
import { routes, page, layout, type StandardSchemaV1 } from '../src/router/index.js';
import type { Component } from 'svelte';

const C = (() => {}) as unknown as Component<Record<string, unknown>>;
const NumId: StandardSchemaV1<{ id: number }> = {
	'~standard': {
		version: 1,
		vendor: 't',
		validate: () => ({ value: { id: 1 } }),
		types: { output: { id: 0 } }
	}
};

const shell = layout('app', C, { load: async () => ({ user: 'ada' as string }) });
const section = layout('docs', C, { load: async () => ({ nav: ['a'] as string[] }) });

const app = routes(
	shell({
		'/': page(C, { load: async () => ({ featured: ['x'] as string[] }) }),
		'/post/[id]': page(C, { params: NumId, load: async (c) => ({ n: c.params.id }) }),
		'/login': page(C, { actions: { default: async () => ({ ok: true as boolean }) } }),
		'/search': page(C, {
			search: NumId as unknown as StandardSchemaV1<{ q: string }>,
			load: async (c) => ({ q: c.search.q })
		}),
		...section({
			'/docs/[slug]': page(C, { load: async (c) => ({ doc: c.params.slug }) })
		}),
		'/api/[id]': { GET: (c) => new Response(c.params.id) }
	}),
	{ error: C }
);
type App = typeof app.$infer;

// ── endpoint entries + the typed api() client ─────────────────────────────────────────────────
import { GET, POST, api } from '../src/router/index.js';

const Body: StandardSchemaV1<{ title: string }> = NumId as never;
const typedApp = routes({
	// PLAIN returns are the JSON payload — typed end to end
	'/posts/[id]': { GET: GET<'/posts/[id]'>((c) => ({ id: c.params.id, title: 'x' as string })) },
	'/posts': { POST: POST(Body, (c) => ({ created: c.input.title })) },
	// a raw Response return erases to unknown (its payload is inside the Response)
	'/raw': { GET: (c) => c.json({ opaque: true }) }
});
type TApp = typeof typedApp.$infer;

const _out: TApp['/posts/[id]']['get']['out'] = { id: '1', title: 't' };
const _in: TApp['/posts']['post']['in'] = { title: 't' };
const _params: TApp['/posts/[id]']['params'] = { id: '1' };

const client = api<TApp>('http://x');
// typed returns + required params + schema-typed body
const _r1: Promise<{ id: string; title: string }> = client.get('/posts/[id]', {
	params: { id: '1' }
});
const _r2: Promise<{ created: string }> = client.post('/posts', { body: { title: 'hi' } });
// a Response-returning endpoint types unknown
const _r3: Promise<unknown> = client.get('/raw');
// @ts-expect-error — page paths carry no verbs, the client rejects them
client.get('/');
// @ts-expect-error — params are REQUIRED when the pattern has any
client.get('/posts/[id]');
// @ts-expect-error — the body must match the schema output
client.post('/posts', { body: { wrong: true } });

// Merged cascade: shell load ∧ page load.
const _home: App['/']['data'] = { user: 'x', featured: ['a'] };
// Schema-coerced params (number, not string).
const _postParams: App['/post/[id]']['params'] = { id: 5 };
// @ts-expect-error — params.id is number
const _bad: App['/post/[id]']['params'] = { id: 'str' };
// Action return → form (nullable).
const _form: App['/login']['form'] = { ok: true };
const _noForm: App['/login']['form'] = null;
// Typed search.
const _search: App['/search']['search'] = { q: 'x' };
// Nested layout: shell ∧ section data.
const _docData: App['/docs/[slug]']['data'] = { user: 'x', nav: ['a'], doc: 'y' };
// Layout keys.
const _shell: App['(app)']['data'] = { user: 'x' };
const _section: App['(docs)']['data'] = { user: 'x', nav: ['a'] };

void [_home, _postParams, _bad, _form, _noForm, _search, _docData, _shell, _section];
