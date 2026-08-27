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
