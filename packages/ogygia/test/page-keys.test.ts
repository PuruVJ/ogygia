// SEED SHAPING — the static analysis of which `page.data` keys a module reads (AST, binding-
// resolved). Every pattern below is lifted from a real app's islands (a CMS platform, 2026-09-16)
// or from the playground fixtures. The contract: literal keys → the set; anything the analysis
// cannot pin → 'all'; no page import → null.
import { describe, expect, it } from 'vitest';
import { page_data_keys, merge_page_keys } from '../src/compiler/link/page-keys.js';

const ts = (code: string) => {
	const r = page_data_keys(code, '/app/x.ts', 'script');
	return r === 'all' || r === null ? r : [...r].sort();
};
const svelte = (code: string) => {
	const r = page_data_keys(code, '/app/X.svelte', 'svelte');
	return r === 'all' || r === null ? r : [...r].sort();
};

describe('page_data_keys — scripts', () => {
	it('null when the module never imports the page', () => {
		expect(ts(`const data = { a: 1 }; console.log(data.a);`)).toBeNull();
		expect(ts(`import { goto } from '$app/navigation'; import { page } from 'svelte'; goto(page.data.x);`)).toBeNull();
	});
	it('$app/state: page.data.key, optional chaining, nested paths keep the top-level key', () => {
		expect(ts(`import { page } from '$app/state';\nexport const l = page.data._locale; const u = page.data?.user?.access_token; const c = page.data?.userCountry?.country;`)).toEqual(['_locale', 'user', 'userCountry']);
	});
	it('get(page).data.key, and the whole page aliased then read (the analytics helper)', () => {
		expect(ts(`import { get } from 'svelte/store'; import { page } from '$app/stores';\nexport function init() { const value = get(page); const lang = value?.data?.langCode; const t = value?.data?.content?.data?.template || ''; return lang + t; }`)).toEqual(['content', 'langCode']);
		expect(ts(`import { page } from '$app/state';\nconst p = page; export const x = p.data.order.customer;`)).toEqual(['order']);
	});
	it('bracket access with a string literal', () => {
		expect(ts(`import { page } from '$app/state';\nexport const x = page.data['site-config']; export const y = page.data?.["flags"];`)).toEqual(['flags', 'site-config']);
	});
	it('derived(page, ($page) => …) and derived([a, page], ([$a, $page]) => …) name the page parameter', () => {
		expect(ts(`import { derived } from 'svelte/store'; import { page } from '$app/stores';\nexport const country = derived(page, ($page) => $page.params.country || ''); export const allowed = derived(page, (p) => p.data.PUBLIC_UCE || []);`)).toEqual(['PUBLIC_UCE']);
		expect(ts(`import { derived } from 'svelte/store'; import { page } from '$app/stores';\nexport const x = derived([user, page, country], ([$user, $page, $country], set) => { const a = $page.data.PUBLIC_UCE_SESSION_CONFIG_FOR_COUNTRIES; const h = $page.url.pathname; set(a + h); });`)).toEqual(['PUBLIC_UCE_SESSION_CONFIG_FOR_COUNTRIES']);
	});
	it('only url / params / route / status reads → an empty set (the seed still ships, data empty)', () => {
		expect(ts(`import { page } from '$app/state';\nexport const c = page.params.country?.toLowerCase(); export const r = page.route.id; export const s = page.status; export const h = page.url.href;`)).toEqual([]);
	});
	it('destructuring page.data names its keys', () => {
		expect(ts(`import { page } from '$app/state';\nconst { _locale, user } = page.data; export default _locale + user;`)).toEqual(['_locale', 'user']);
	});
	it('an aliased import name', () => {
		expect(ts(`import { page as pg } from '$app/stores';\nexport const l = get(pg).data._locale;`)).toEqual(['_locale']);
	});
});

describe('page_data_keys — components', () => {
	it('$page?.data?.key in the script and page.data.key in the template', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/stores';\n\tcurrentUrl.set($page.url.href);\n\tconst l = $page?.data?._locale;\n\tconst d = $page?.data?.pageContent?.createdDate;\n</script>\n<p>{$page.data.userCountry.country}</p>`)).toEqual(['_locale', 'pageContent', 'userCountry']);
		expect(svelte(`<script lang="ts">\n\timport { page } from '$app/state';\n\tconst summary = $derived(\`\${page.params.id}: \${page.data.order.customer}\`);\n</script>\n<div>Derived from page: {summary}</div>`)).toEqual(['order']);
	});
	it('a module script and an {#each} over page data', () => {
		expect(svelte(`<script module>\n\timport { page } from '$app/state';\n</script>\n{#each page.data.items as item}<b>{item}</b>{/each}`)).toEqual(['items']);
	});
	it('the playground reader that hands page.data to an arrow → all', () => {
		expect(svelte(`<script lang="ts">\n\timport { page } from '$app/state';\n\tconst d = () => page.data as any;\n</script>\n<p>{d().locale}</p>`)).toBe('all');
	});
	it('a component that only reads params → empty set', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/state';\n\tconst fr = page.params.country?.toLowerCase() === 'ca' && page.params.language?.toLowerCase() === 'fr';\n</script>\n{fr}`)).toEqual([]);
	});
});

describe('page_data_keys — doubt goes to all', () => {
	it('page.data used whole: passed on, spread, compared, returned', () => {
		expect(ts(`import { page } from '$app/stores';\nhelper(get(page).data);`)).toBe('all');
		expect(ts(`import { page } from '$app/state';\nexport const all = { ...page.data };`)).toBe('all');
		expect(ts(`import { page } from '$app/state';\nexport const same = page.data === cache;`)).toBe('all');
		expect(ts(`import { page } from '$app/state';\nexport const f = () => page.data;`)).toBe('all');
	});
	it('the data object aliased or destructured off the page', () => {
		expect(ts(`import { page } from '$app/state';\nconst { data } = page; export const x = data.a;`)).toBe('all');
		expect(ts(`import { page } from '$app/state';\nconst d = page.data; export const x = d.a;`)).toBe('all');
	});
	it('dynamic index, subscribe, namespace import, the whole page passed to a function', () => {
		expect(ts(`import { page } from '$app/state';\nexport const v = page.data[key];`)).toBe('all');
		expect(ts(`import { page } from '$app/stores';\npage.subscribe((v) => track(v));`)).toBe('all');
		expect(ts(`import * as app from '$app/state';\nexport const x = app.page.data.a;`)).toBe('all');
		expect(ts(`import { page } from '$app/state';\nanalytics.init(page);`)).toBe('all');
	});
	it('a same-named unrelated identifier is not the page: `foo.page`, `pageContent`', () => {
		expect(ts(`import { page } from '$app/state';\nexport const a = page.data.x; export const b = state.page.data.y; const pageContent = obj.pageContent.data.z; export { pageContent };`)).toEqual(['x']);
	});
	it('prose that says "page" is not a reference', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/state';\n\t// the page store\n\tconst l = page.data._locale;\n</script>\n<p>Derived from page: {l}</p>`)).toEqual(['_locale']);
	});
});

describe('merge_page_keys', () => {
	it('unions sets, all absorbs, null is identity', () => {
		expect([...(merge_page_keys(new Set(['a']), new Set(['b'])) as Set<string>)].sort()).toEqual(['a', 'b']);
		expect(merge_page_keys(new Set(['a']), 'all')).toBe('all');
		expect(merge_page_keys(null, new Set(['a']))).toEqual(new Set(['a']));
		expect(merge_page_keys(null, null)).toBeNull();
	});
});

// ── the demented cases: TypeScript wrappers, scoping, templates, preprocessors ─────────────────
describe('page_data_keys — the demented cases', () => {
	it('TypeScript wrappers: as / ! / satisfies / parentheses around the page or page.data', () => {
		expect(ts(`import { page } from '$app/state';\nexport const a = (page as any).data.x; export const b = page!.data.y; export const c = (page.data as Foo).z; export const d = (page.data satisfies Foo).w; export const e = ((page)).data.v;`)).toEqual(['v', 'w', 'x', 'y', 'z']);
		expect(ts(`import { page } from '$app/state';\nconst p = page as unknown as Foo; export const x = p.data.q;`)).toEqual(['q']);
	});
	it('an alias is scoped to its function: an unrelated `value` elsewhere is not the page', () => {
		expect(ts(`import { get } from 'svelte/store'; import { page } from '$app/stores';\nclass A { private _s = false; public get s() { return this._s; } public set s(value: boolean) { this._s = value; } init() { const value = get(page); this.lang = value?.data?.langCode; } }`)).toEqual(['langCode']);
	});
	it('an alias declared in one function is not applied in a sibling function', () => {
		expect(ts(`import { page } from '$app/state';\nfunction a() { const p = page; return p.data.x; } function b(p: Other) { return send(p); } export { a, b };`)).toEqual(['x']);
	});
	it('a shadowing local named page in an inner scope is over-approximated, never a crash', () => {
		const r = ts(`import { page } from '$app/state';\nexport const x = page.data.a; function f() { const page = other(); return page.data.b; }`);
		expect(r === 'all' || (Array.isArray(r) && r.includes('a'))).toBe(true);
	});
	it('component: <style lang="scss"> with // comments does not stop the analysis', () => {
		expect(svelte(`<script lang="ts">\n\timport { page } from '$app/stores';\n\tlet l = $page?.data?._locale;\n</script>\n<p>{l}</p>\n<style lang="scss">\n\t// <!-- a comment the CSS parser hates -->\n\t.a { .b { color: red; } }\n</style>`)).toEqual(['_locale']);
	});
	it('component: template constructs — {#if} {#each} {#await} {@const} {@html} attributes, bind:, handlers, snippets, svelte:head', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/state';\n</script>\n<svelte:head><title>{page.data.title}</title></svelte:head>\n{#if page.data.flag}<b>on</b>{/if}\n{#each page.data.items as it}{@const label = page.data.labels[it]}<span>{label}</span>{/each}\n{#await page.data.later then v}<i>{v}</i>{/await}\n{@html page.data.html}\n<Comp a={page.data.prop} b={page.url.href} onclick={() => use(page.data.handler)} />\n<input bind:value={page.data.form.q} />\n{#snippet row(x)}<em>{page.data.rows[x]}</em>{/snippet}`)).toEqual(['flag', 'form', 'handler', 'html', 'items', 'labels', 'later', 'prop', 'rows', 'title']);
	});
	it('component: a spread of page.data into attributes → all', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/state';\n</script>\n<Comp {...page.data} />`)).toBe('all');
	});
	it('component: runes — $state, $derived.by, $effect, class fields; legacy context="module"', () => {
		expect(svelte(`<script context="module">\n\timport { page } from '$app/state';\n</script>\n<script lang="ts">\n\tlet n = $state(page.data.count);\n\tconst d = $derived.by(() => page.data.deep.x);\n\t$effect(() => { track(page.data.track); });\n\tclass C { k = page.data.klass; }\n</script>\n<p>{n}{d}</p>`)).toEqual(['count', 'deep', 'klass', 'track']);
	});
	it('component: the whole page passed to a helper in the template → all, with the reason', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/state';\n</script>\n<p>{fmt(page)}</p>`)).toBe('all');
	});
	it('a reason names the construct and the line', async () => {
		const { page_data_keys_answer } = await import('../src/compiler/link/page-keys.js');
		const a = page_data_keys_answer(`import { page } from '$app/state';\nconst a = 1;\nexport const x = helper(page.data);`, '/app/x.ts', 'script');
		expect(a.keys).toBe('all');
		expect(a.reason?.line).toBe(3);
		expect(a.reason?.why).toContain('handed whole to helper');
	});
	it('scale: a long module with many reads stays linear and exact', () => {
		const lines = Array.from({ length: 2000 }, (_, i) => `export const v${i} = page.data.k${i % 50}?.x ?? page.url.pathname;`).join('\n');
		const r = ts(`import { page } from '$app/state';\n${lines}`);
		expect(Array.isArray(r) && r.length === 50).toBe(true);
	});
});

// ── following `helper(page)`: local helpers at transform time, imported ones at bundle time ────
describe('page_data_keys — call following', () => {
	it('a helper of the same module is followed: its parameter is the page inside it', async () => {
		expect(ts(`import { page } from '$app/state';\nfunction getParams(p) { return p.url.searchParams.get('q'); }\nexport const q = getParams(page);`)).toEqual([]);
		expect(ts(`import { page } from '$app/state';\nconst pick = (p) => p.data.chosen;\nexport const c = pick(page);`)).toEqual(['chosen']);
		expect(ts(`import { page } from '$app/state';\nfunction leak(p) { return send(p); }\nexport const c = leak(page);`)).toBe('all');
	});
	it('an imported helper is recorded as pending, the rest of the module still pinned', async () => {
		const { page_data_keys_answer } = await import('../src/compiler/link/page-keys.js');
		const a = page_data_keys_answer(`import { page } from '$app/state';\nimport { getParams } from '@app/common/utils';\nexport const p = getParams(page); export const l = page.data._locale;`, '/app/x.ts', 'script');
		expect(a.keys).toEqual(new Set(['_locale']));
		expect(a.pending).toEqual([{ specifier: '@app/common/utils', imported: 'getParams', arg: 0, line: 3 }]);
	});
	it('summarize_export: what the helper reads of its page parameter', async () => {
		const { summarize_export } = await import('../src/compiler/link/page-keys.js');
		expect(summarize_export(`export function getParams(page) { const s = page.url.searchParams; return page.url.search.length > 1 ? s : {}; }`, '/pkg/routing.ts', 'script', 'getParams', 0)).toEqual(new Set());
		expect(summarize_export(`export const url = (p, base) => base + p.data.origin;`, '/pkg/url.ts', 'script', 'url', 0)).toEqual(new Set(['origin']));
		expect(summarize_export(`export function isActive(route, p) { return p.url.pathname.startsWith(route) && p.data.flags.nav; }`, '/pkg/nav.ts', 'script', 'isActive', 1)).toEqual(new Set(['flags']));
		expect(summarize_export(`export function leak(p) { return other(p); }`, '/pkg/leak.ts', 'script', 'leak', 0)).toBe('all');
		expect(summarize_export(`export function f({ url }) { return url; }`, '/pkg/d.ts', 'script', 'f', 0)).toBe('all');
		expect(summarize_export(`export const x = 1;`, '/pkg/none.ts', 'script', 'getParams', 0)).toBe('all');
	});
	it('summarize_export: a barrel re-export says where to follow', async () => {
		const { summarize_export } = await import('../src/compiler/link/page-keys.js');
		expect(summarize_export(`export { getParams } from './routing';\nexport * from './misc';`, '/pkg/utils.ts', 'script', 'getParams', 0)).toEqual({ follow: ['./routing'], imported: 'getParams' });
		expect(summarize_export(`export * from './a';\nexport * from './b';`, '/pkg/utils.ts', 'script', 'getParams', 0)).toEqual({ follow: ['./a', './b'], imported: 'getParams' });
		expect(summarize_export(`import { getParams as gp } from './routing';\nexport { gp as getParams };`, '/pkg/utils.ts', 'script', 'getParams', 0)).toEqual({ follow: ['./routing'], imported: 'getParams' });
	});
});

// ── the bundle-time half: resolve + summarize, through barrels, with a fake fs ────────────────
describe('follow_pending_page_calls', () => {
	const files: Record<string, string> = {
		'/pkg/common/utils.ts': `export * from './misc';\nexport { getParams } from './routing';\nexport { url } from './url';`,
		'/pkg/common/routing.ts': `export function getParams(page) { const q = page.url.searchParams; return q.get('x'); }`,
		'/pkg/common/url.ts': `export const url = (p) => p.data.origin + p.url.pathname;`,
		'/pkg/common/misc.ts': `export const other = 1;`,
		'/pkg/common/leaky.ts': `export function leak(p) { return send(p); }`,
		'/pkg/star.ts': `export * from './common/misc';\nexport * from './common/routing';`
	};
	const resolve = async (spec: string, importer: string) => {
		if (spec.startsWith('@app/common')) return { id: '/pkg/common/' + (spec.split('/')[2] ?? 'utils') + '.ts' };
		if (spec.startsWith('./')) { const dir = importer.replace(/[^/]+$/, ''); return { id: dir + spec.slice(2) + '.ts' }; }
		return null;
	};
	const read = (f: string) => files[f] ?? null;
	const program = () => ({ page_keys: new Map<string, any>(), page_key_reasons: new Map<string, any>(), page_pending: new Map<string, any>() });

	it('follows getParams(page) through a barrel to its url-only reader; url(page) adds its key', async () => {
		const { follow_pending_page_calls } = await import('../src/compiler/link/page-keys.js');
		const p = program();
		p.page_keys.set('/app/A.svelte', new Set(['_locale']));
		p.page_pending.set('/app/A.svelte', [
			{ specifier: '@app/common/utils', imported: 'getParams', arg: 0, line: 3 },
			{ specifier: '@app/common/utils', imported: 'url', arg: 0, line: 4 }
		]);
		await follow_pending_page_calls(p, resolve, read);
		expect(p.page_keys.get('/app/A.svelte')).toEqual(new Set(['_locale', 'origin']));
		expect(p.page_key_reasons.has('/app/A.svelte')).toBe(false);
		expect(p.page_pending.size).toBe(0);
	});
	it('an `export *` fan-out is searched; a helper that hands the page on → all with a reason', async () => {
		const { follow_pending_page_calls } = await import('../src/compiler/link/page-keys.js');
		const p = program();
		p.page_keys.set('/app/B.ts', new Set());
		p.page_pending.set('/app/B.ts', [{ specifier: './pkg/star', imported: 'getParams', arg: 0, line: 2 }]);
		await follow_pending_page_calls(p, async (s, i) => (s === './pkg/star' ? { id: '/pkg/star.ts' } : resolve(s, i)), read);
		expect(p.page_keys.get('/app/B.ts')).toEqual(new Set());
		const q = program();
		q.page_keys.set('/app/C.ts', new Set(['a']));
		q.page_pending.set('/app/C.ts', [{ specifier: '@app/common/leaky', imported: 'leak', arg: 0, line: 9 }]);
		await follow_pending_page_calls(q, resolve, read);
		expect(q.page_keys.get('/app/C.ts')).toBe('all');
		expect(q.page_key_reasons.get('/app/C.ts')).toMatchObject({ line: 9 });
		expect(q.page_key_reasons.get('/app/C.ts')?.why).toContain('leak(…)');
	});
	it('an unresolvable specifier → all, named in the reason', async () => {
		const { follow_pending_page_calls } = await import('../src/compiler/link/page-keys.js');
		const p = program();
		p.page_keys.set('/app/D.ts', new Set());
		p.page_pending.set('/app/D.ts', [{ specifier: 'nowhere', imported: 'f', arg: 0, line: 1 }]);
		await follow_pending_page_calls(p, resolve, read);
		expect(p.page_keys.get('/app/D.ts')).toBe('all');
		expect(p.page_key_reasons.get('/app/D.ts')?.why).toContain('could not be resolved');
	});
});

describe('page_data_keys — safe built-ins', () => {
	it('Object.keys(page) reads names only; isEmpty(page) from a library still hands the page on', async () => {
		const { summarize_export } = await import('../src/compiler/link/page-keys.js');
		expect(summarize_export(`export function getParams(page) { if (Object.keys(page).length < 1) return {}; return page.url.search; }`, '/pkg/r.ts', 'script', 'getParams', 0)).toEqual(new Set());
		expect(summarize_export(`import { isEmpty } from 'lodash-es';\nexport function getParams(page) { if (isEmpty(page)) return {}; return page.url.search; }`, '/pkg/r.ts', 'script', 'getParams', 0)).toBe('all');
	});
});

describe('page_data_keys — guards and subscribers', () => {
	it('`const { a, b } = $page?.data || {}` names its keys; a subscriber parameter is the page', () => {
		expect(svelte(`<script>\n\timport { page } from '$app/stores';\n\tconst { isRangePage = false, isDebugAllowed } = $page?.data || {};\n\tconst c = ($page?.data ?? {}).canonicalUrl;\n</script>\n{isRangePage}{isDebugAllowed}{c}`)).toEqual(['canonicalUrl', 'isDebugAllowed', 'isRangePage']);
		expect(ts(`import { page } from '$app/stores';\nexport const off = page.subscribe((pageData) => { if (pageData.data?.showEmbeddedSurveyBtn) go(pageData.url.href); });`)).toEqual(['showEmbeddedSurveyBtn']);
		expect(ts(`import { page } from '$app/stores';\nexport const off = page.subscribe(callback);`)).toBe('all');
	});
});

describe('page_data_keys — the PENDING13 shape', () => {
	it('`if (!page?.url) return` keeps a helper summarizable as url/params-only', async () => {
		const { summarize_export } = await import('../src/compiler/link/page-keys.js');
		expect(summarize_export(`export function getParams(page) { let r = {}; if (!page?.url) return r; const s = page?.url?.search || ''; const o = page?.params; if (o && Object.keys(o).length > 0) r = { ...r, ...o }; return r; }`, '/app/routing.ts', 'script', 'getParams', 0)).toEqual(new Set());
	});
});
