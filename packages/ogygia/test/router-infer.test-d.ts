/* Type-level guard for router.$infer — cascade data, path params, action-return form. tsc-only. */
import { routes } from '../src/router/index.js';
import type { Component } from 'svelte';

declare const App: Component;
declare const Home: Component;
declare const Doc: Component;

const router = routes((r) =>
	r
		.layout(App)
		.load(() => ({ user: { id: 1 } }))
		.routes({
			'/': (r) => r.page(Home).load(() => ({ featured: ['x'] })),
			'/docs': (r) =>
				r.layout(Doc).load(() => ({ nav: ['a'] })).routes({
					'/[slug]': (r) => r.page(Doc).load((c) => ({ doc: c.params.slug })),
				}),
			'/login': (r) => r.page(Home).action('go', () => ({ ok: true })),
		})
);

type Routes = typeof router.$infer;

// data cascades: leaf sees user (root) + nav (mid) + doc (own)
type _D = Routes['/docs/[slug]']['data'];
const _d: _D = { user: { id: 1 }, nav: ['a'], doc: 's' };
// @ts-expect-error doc is a string, not number
const _dBad: _D = { user: { id: 1 }, nav: ['a'], doc: 1 };

// params typed from the path
const _p: Routes['/docs/[slug]']['params'] = { slug: 's' };
// @ts-expect-error the root route has no slug param
const _pBad: Routes['/']['params'] = { slug: 's' };

// form is the action's return type
const _f: Routes['/login']['form'] = { ok: true };

void _d; void _dBad; void _p; void _pBad; void _f;
