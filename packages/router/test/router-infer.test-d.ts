/* Type-level guard for router v2 `$infer` — merged cascade data (Kit's rule), schema-coerced params,
 * typed search, action-return form, and layout keys `App['(name)']`. tsc-only (no runtime). */
import { routes, page, layout, type StandardSchemaV1 } from '../src/index.ts';
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
import { GET, POST, api, when, type Handler } from '../src/index.ts';

/** exact type equality: assignable both ways, and not `any` */
type Equal<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const expect_type = <T extends true>(_proof: T): void => {};

const Body: StandardSchemaV1<{ title: string }> = NumId as never;

// THE KEY TYPES EVERY HANDLER: strict params, the handler's own return kept — bare or wrapped,
// top-level, under a layout, under nested layouts, behind `when()`.
const admin = layout('admin', C);
const deep = layout('deep', C);
// a handler written OUTSIDE the table: `satisfies` checks it against its route, return type kept
const outside = ((c) => ({
	id: c.params.id,
	outside: true as const
})) satisfies Handler<'/out/[id]'>;
const typedApp = routes({
	'/posts/[id]': { GET: (c) => ({ id: c.params.id, title: 'x' as string }) },
	'/wrapped/[id]': { GET: GET((c) => ({ wrapped: c.params.id })) },
	'/posts': { POST: POST(Body, (c) => ({ created: c.input.title })) },
	'/posts/[id]/edit': { PUT: POST(Body, (c) => ({ id: c.params.id, title: c.input.title })) },
	...admin({
		'/admin/[user]': { GET: (c) => ({ user: c.params.user }) },
		...deep({
			'/admin/[user]/[tab]': { GET: GET((c) => ({ tab: c.params.tab, user: c.params.user })) }
		})
	}),
	'/gated/[id]': when(() => true, { GET: (c) => ({ gated: c.params.id }) }),
	'/out/[id]': { GET: outside },
	// a raw Response return erases to unknown (its payload is inside the Response)
	'/raw': { GET: (c) => c.json({ opaque: true }) }
});
type TApp = typeof typedApp.$infer;

expect_type<Equal<TApp['/posts/[id]']['get']['out'], { id: string; title: string }>>(true);
expect_type<Equal<TApp['/wrapped/[id]']['get']['out'], { wrapped: string }>>(true);
expect_type<Equal<TApp['/posts']['post']['in'], { title: string }>>(true);
expect_type<Equal<TApp['/posts/[id]/edit']['put']['out'], { id: string; title: string }>>(true);
expect_type<Equal<TApp['/admin/[user]']['get']['out'], { user: string }>>(true);
expect_type<Equal<TApp['/admin/[user]/[tab]']['get']['out'], { tab: string; user: string }>>(true);
expect_type<Equal<TApp['/gated/[id]']['get']['out'], { gated: string }>>(true);
expect_type<Equal<TApp['/out/[id]']['get']['out'], { id: string; outside: true }>>(true);
const _params: TApp['/posts/[id]']['params'] = { id: '1' };

routes({
	// @ts-expect-error — the key has no `slug`: a strict param, not an indexable record
	'/strict/[id]': { GET: (c) => c.params.slug.length },
	// @ts-expect-error — the wrapper is strict the same way
	'/strict2/[id]': { GET: GET((c) => c.params.slug.length) }
});

const client = api<TApp>('http://x');
// typed returns + required params + schema-typed body
const _r1: Promise<{ id: string; title: string }> = client.get('/posts/[id]', {
	params: { id: '1' }
});
const _r2: Promise<{ created: string }> = client.post('/posts', { body: { title: 'hi' } });
const _r4: Promise<{ tab: string; user: string }> = client.get('/admin/[user]/[tab]', {
	params: { user: 'u', tab: 't' }
});
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
