import { describe, expect, it } from 'vitest';
import {
	constant_work,
	each_blocks,
	formatter_rewrite,
	hoist_plan,
	key_sources,
	late_island_keys,
	line_rw,
	load_inputs,
	needs_previous,
	parent_use,
	promise_all_rewrite
} from '../src/profiler/source-scan.js';
import { tag_fills, unread_rows, type DrillNode } from '../src/profiler/drill.js';

// Which lines of a load feed each key it returns: a wait on one of them was for that key.

const LOAD = `import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, fetch }) => {
	const origin = url.origin;
	const user = await svc(origin, 'user');
	const [a, b] = await Promise.all([svc(origin, 'nav'), svc(origin, 'seo')]);
	const live = await (await fetch(origin + '/live')).json();
	const session = await span('s', async () => {
		const res = await fetch(origin + '/session');
		return res.json();
	});
	const flags = await span('f', async () => {
		const res = await fetch(origin + '/flags');
		return res.json();
	});
	const stock: Record<string, number> = {};
	for (const id of ['a', 'b']) {
		const s = await stockOf(origin, id);
		stock[s.id] = s.stock;
	}
	const list: string[] = [];
	list.push(user.name);
	return {
		live_at: live.at as number,
		services: [a, b].map((x) => x.name),
		session,
		flags,
		stock,
		list,
		greeting: 'hi'
	};
};

function helper() {
	return { nope: 1 };
}
`;

describe('key_sources', () => {
	const m = key_sources(LOAD)!;

	it('follows a key back through the variables it reads to the lines that make them', () => {
		expect(m.get('live_at')).toEqual([4, 7, 24]);
		expect(m.get('services')).toEqual([4, 6, 25]);
		expect(m.get('greeting')).toEqual([30]);
	});

	it('a local in a callback is that callback’s own: two `res` do not tie session to flags', () => {
		expect(m.get('session')).toEqual([4, 8, 9, 10, 11, 26]);
		expect(m.get('flags')).toEqual([4, 12, 13, 14, 15, 27]);
	});

	it('a typed declaration, then filled by index or by push', () => {
		// 17: the loop header gives `id` to the call on 18
		expect(m.get('stock')).toEqual([4, 16, 17, 18, 19, 28]);
		expect(m.get('list')).toEqual([4, 5, 21, 22, 29]);
	});

	it('a callback’s parameter is its own: `(id) => …` in a key does not tie it to the loop’s `id`', () => {
		const m2 = key_sources(`export async function load() {
	const rows = await getRows();
	for (const id of ['a']) await ping(id);
	return { ids: rows.map((id) => id.x) };
}`)!;
		expect(m2.get('ids')).toEqual([2, 4]);
	});

	it('only the load’s return, not a helper’s after it', () => {
		expect(m.has('nope')).toBe(false);
	});
});

describe('constant_work', () => {
	it('load lines that read only the module: computed the same on every request', () => {
		const src = [
			"import { PRODUCTS } from '$lib/data';",
			"import { validate, attach, matches, rank } from '$lib/catalog';",
			'const cache = new Map();',
			'const LIMIT = 10;',
			'export const load = async ({ url }) => {',
			"\tconst term = url.searchParams.get('q');",
			'\tconst valid = validate(PRODUCTS);',
			'\tconst joined = attach(valid, LIMIT);',
			'\tconst hits = joined.filter((p) => matches(p, term));',
			'\tconst now = Date.now();',
			"\tconst hit = cache.get('x');",
			'\tconst ranked = rank(valid);',
			'\tconst again = rank(hits);',
			'\tconst live = await fetch(PRODUCTS[0].url);',
			'\treturn { hits, now, hit, ranked, again, live };',
			'};'
		].join('\n');
		expect(constant_work(src)).toEqual([
			{ line: 7, names: ['valid'], calls: ['validate'] },
			{ line: 8, names: ['joined'], calls: ['attach'] },
			// `rank` also runs on a per-request line (13): its time is not all this line's
			{ line: 12, names: ['ranked'], calls: [] }
		]);
	});

	it("a per-call module's value (node:crypto, $app/server) is never the same every request", () => {
		const src = [
			"import { randomUUID } from 'node:crypto';",
			"import { hrtime } from 'process';",
			"import { getRequestEvent } from '$app/server';",
			"import { validate, PRODUCTS } from '$lib/data';",
			'export const load = async () => {',
			'\tconst nonce = randomUUID();',
			'\tconst t = hrtime();',
			'\tconst ev = getRequestEvent();',
			'\tconst valid = validate(PRODUCTS);',
			'\treturn { nonce, t, ev, valid };',
			'};'
		].join('\n');
		expect(constant_work(src)).toEqual([{ line: 9, names: ['valid'], calls: ['validate'] }]);
	});

	it("a helper of the file that reads the disk, a clock or a random, or changes the file's state, answers per call", () => {
		const src = [
			"import { readFileSync } from 'node:fs';",
			"import { PRODUCTS, validate } from '$lib/data';",
			'const seen = new Map();',
			'let count = 0;',
			"function readManifest() {\n\treturn readFileSync('m.json', 'utf8').length;\n}",
			'function viaHelper() {\n\treturn readManifest() + 1;\n}',
			'const stamp = () => Date.now();',
			'function roll() {\n\treturn Math.random();\n}',
			'function bump() {\n\tcount++;\n\treturn count;\n}',
			'function note(x) {\n\tseen.set(x, 1);\n\treturn x;\n}',
			'function pure(x) {\n\treturn validate(x).length;\n}',
			'export const load = async () => {',
			'\tconst a = readManifest();',
			'\tconst b = viaHelper();',
			'\tconst c = stamp();',
			'\tconst d = roll();',
			'\tconst e = bump();',
			'\tconst f = note(PRODUCTS);',
			'\tconst g = pure(PRODUCTS);',
			'\treturn { a, b, c, d, e, f, g };',
			'};'
		].join('\n');
		expect(constant_work(src).map((w) => w.names[0])).toEqual(['g']);
	});

	it('review fixes: a per-call name imported over several lines; a helper with no braces; a load name that shadows the module', () => {
		// the per-call function sits on a continuation line of the import
		const multi = [
			"import {\n\trandomUUID\n} from 'node:crypto';",
			"import { PRODUCTS } from '$lib/data';",
			'function makeId(p) {\n\treturn p.id + randomUUID();\n}',
			'export const load = async () => {',
			'\tconst ids = PRODUCTS.map((p) => makeId(p));',
			'\treturn { ids };',
			'};'
		].join('\n');
		expect(constant_work(multi)).toEqual([]);
		expect(hoist_plan(multi)).toBeNull();
		// a clock read on the line after the arrow
		const arrow = [
			"import { PRODUCTS } from '$lib/data';",
			'const stamp = () =>\n\tDate.now();',
			'const tag = (p) => ({ ...p, at: stamp() });',
			'export const load = async () => {',
			'\tconst tagged = PRODUCTS.map(tag);',
			'\treturn { tagged };',
			'};'
		].join('\n');
		expect(constant_work(arrow)).toEqual([]);
		// `products` here is the request's rows, not the imported fixture
		const shadow = [
			"import { products, sortAll } from './fixtures';",
			'export const load = async ({ locals }) => {',
			'\tconst products = await locals.db.all();',
			'\tconst sorted = sortAll(products);',
			'\treturn { sorted };',
			'};'
		].join('\n');
		expect(constant_work(shadow)).toEqual([]);
	});

	it('a value the load changes afterwards is its own, and so is what it was made from', () => {
		const src = [
			"import { DEFAULTS, PRODUCTS, validate, rank } from '$lib/data';",
			'export const load = async ({ locals }) => {',
			'\tconst state = structuredClone(DEFAULTS);',
			'\tstate.user.name = locals.name;',
			'\tconst list = validate(PRODUCTS);',
			'\tconst alias = list;',
			'\talias.push(locals.extra);',
			'\tconst ranked = rank(PRODUCTS);',
			'\tranked.sort((a, b) => a.n - b.n);',
			'\tconst counts = validate(DEFAULTS);',
			'\tcounts.n++;',
			'\tconst kept = validate(DEFAULTS);',
			'\tObject.assign(kept, locals);',
			'\tconst safe = rank(DEFAULTS);',
			'\treturn { state, alias, ranked, counts, kept, safe };',
			'};'
		].join('\n');
		// (`rank` also runs on line 8, which stays: its time is not all this line's)
		expect(constant_work(src)).toEqual([{ line: 14, names: ['safe'], calls: [] }]);
	});

	it('hoist_plan: the costly lines and what they read, placed above the load', () => {
		const src = [
			"import { validate, attach, PRODUCTS } from '$lib/data';",
			'const LIMIT = 10;',
			'export const load = async ({ url }) => {',
			'\tconst unused = PRODUCTS;',
			'\tconst valid = validate(PRODUCTS);',
			'\tconst joined = attach(valid, LIMIT);',
			"\treturn { joined, q: url.searchParams.get('q'), unused };",
			'};'
		].join('\n');
		expect(hoist_plan(src)).toEqual({
			above: 3,
			stmts: [
				{ line: 5, end: 5, names: ['valid'] },
				{ line: 6, end: 6, names: ['joined'] }
			]
		});
	});

	it('hoist_plan: no move when a top-level binding comes after the load, or a moved name clashes', () => {
		const load = [
			'export const load = async () => {',
			'\tconst valid = validate(PRODUCTS);',
			'\treturn { valid };',
			'};'
		];
		const imp = "import { validate, PRODUCTS } from '$lib/data';";
		expect(hoist_plan([imp, ...load].join('\n'))).not.toBeNull();
		// validate() may read RULES: above the load, RULES is not set yet
		expect(hoist_plan([imp, ...load, 'const RULES = [1];'].join('\n'))).toBeNull();
		expect(hoist_plan([imp, ...load, 'export const { a, b } = PRODUCTS;'].join('\n'))).toBeNull();
		expect(hoist_plan([imp, ...load, 'class Rules {}'].join('\n'))).toBeNull();
		// a function after the load is hoisted: fine
		expect(hoist_plan([imp, ...load, 'function helper() {}'].join('\n'))).not.toBeNull();
		// `valid` is already a name of the file
		expect(hoist_plan([imp, 'function valid() {}', ...load].join('\n'))).toBeNull();
		expect(
			hoist_plan(
				["import {\n\tvalidate,\n\tPRODUCTS,\n\tvalid\n} from '$lib/data';", ...load].join('\n')
			)
		).toBeNull();
		// a `const loading` before the load is not the load
		expect(hoist_plan([imp, 'export const loading = true;', ...load].join('\n'))?.above).toBe(3);
	});

	it('a statement wrapped over several lines is read whole', () => {
		const src = [
			"import { validate, PRODUCTS } from '$lib/data';",
			'export const load = async ({ url }) => {',
			'\tconst valid = validate(',
			'\t\tPRODUCTS,',
			'\t\t{ strict: true }',
			'\t);',
			'\tconst hits = validate(',
			"\t\turl.searchParams.get('q')",
			'\t);',
			'\treturn { valid, hits };',
			'};'
		].join('\n');
		// `validate` also runs on a per-request statement (7-9): not counted as this line's cost
		expect(constant_work(src)).toEqual([{ line: 3, names: ['valid'], calls: [] }]);
		expect(
			constant_work(
				src.replace(
					"validate(\n\t\turl.searchParams.get('q')\n\t)",
					"String(\n\t\turl.searchParams.get('q')\n\t)"
				)
			)
		).toEqual([{ line: 3, names: ['valid'], calls: ['validate'] }]);
	});

	it('a value written straight into the return counts too; an object key is not a read', () => {
		const src = [
			"import { span } from 'ogygia/profiler';",
			"import { catalog } from '$lib/data';",
			'export const load = async ({ url }) => {',
			'\treturn {',
			"\t\tcatalog: span('cms.catalog', () => catalog(), (c) => ({ rows: c.products.length })),",
			"\t\tq: url.searchParams.get('q')",
			'\t};',
			'};'
		].join('\n');
		expect(constant_work(src)).toEqual([
			{ line: 5, names: ['catalog'], calls: ['span', 'catalog'] }
		]);
	});
});

describe('each_blocks', () => {
	it('the loops in markup, the key each walks, and the components inside (nested too)', () => {
		const svelte = [
			'<script>let { data } = $props();</script>',
			'<div class="grid">',
			'\t{#each data.results as p, i (p.id)}',
			'\t\t<ResultCard {p} rank={i} />',
			'\t\t{#each p.tags as t}<Tag {t} />{/each}',
			'\t{/each}',
			'</div>',
			'{#each page.data.crumbs as c}<Crumb {c} />{/each}',
			'{#each [1, 2] as n}<span>{n}</span>{/each}',
			'<script>const products = data.catalog.products.map((p) => ({ ...p }));</script>',
			'{#each products as p}<Card {p} />{/each}'
		].join('\n');
		expect(each_blocks(svelte)).toEqual([
			{ line: 3, key: 'results', components: ['ResultCard', 'Tag'] },
			{ line: 5, components: ['Tag'] },
			{ line: 8, key: 'crumbs', components: ['Crumb'] },
			{ line: 9, components: [] },
			// a local: the key the script makes it from
			{ line: 11, key: 'catalog', components: ['Card'] }
		]);
	});
});

describe('late_island_keys', () => {
	it('keys used only as props of islands that wake late', () => {
		const svelte = [
			'<script lang="ts">',
			"\timport Reviews from './Reviews.svelte' with { wake: 'visible' };",
			"\timport Price from './Price.svelte' with { wake: 'load' };",
			"\timport Chart from './Chart.svelte' with { render: 'deferred', wake: 'visible' };",
			'\tlet { data } = $props();',
			'\tconst n = data.count + 1;',
			'</script>',
			'<h1>{data.title}</h1>',
			'<Price price={data.price} />',
			'<Reviews reviews={data.reviews} count={data.count} />',
			'<Chart points={data.points} />'
		].join('\n');
		// title: the page's own markup; price: an eager island; count: the script reads it too;
		// points: its island is already deferred
		expect(late_island_keys(svelte)).toEqual([
			{ key: 'reviews', island: 'Reviews', wake: 'visible', line: 10 }
		]);
	});
});

describe('source reads: the review cases', () => {
	it("a helper's local is not a module value: a line reading the request stays per request", () => {
		const src = [
			"import { parse } from './p';",
			'function helper() {',
			'\tconst id = 1;',
			'\treturn id;',
			'}',
			'export const load = async ({ params }) => {',
			'\tconst { id } = params;',
			'\tconst item = parse(id);',
			'\treturn { item };',
			'};'
		].join('\n');
		expect(constant_work(src)).toEqual([]);
	});

	it("a return type's braces are the type's, not the body", () => {
		const src = [
			'export async function load({ params }): Promise<{ a: string }> {',
			'\tconst a = params.a;',
			'\treturn { a };',
			'}'
		].join('\n');
		expect(key_sources(src)?.get('a')).toEqual([2, 3]);
		// an expression body has no block: nothing, not the next function in the file
		expect(
			key_sources(
				'export const load = () => ({ a: 1 });\nfunction other() {\n\treturn { b: 2 };\n}'
			)
		).toBeNull();
	});

	it('a `let` declared with no value, then assigned in branches', () => {
		const src = [
			'export const load = async ({ url }) => {',
			'\tlet user;',
			'\tif (url.x) user = await getA();',
			'\telse user = await getB();',
			'\treturn { user };',
			'};'
		].join('\n');
		expect(key_sources(src)?.get('user')).toEqual([2, 3, 4, 5]);
	});

	it('page.data.x is the page’s data; post.data.x is not', () => {
		const svelte = [
			'<script>',
			"\timport R from './R.svelte' with { wake: 'visible' };",
			'</script>',
			'<p>{page.data.reviews.length}</p>',
			'<R reviews={data.reviews} />'
		].join('\n');
		// (without the page.data read it would be the late island's alone)
		expect(
			late_island_keys(svelte.replace('<p>{page.data.reviews.length}</p>', '<p>hi</p>'))
		).toEqual([{ key: 'reviews', island: 'R', wake: 'visible', line: 5 }]);
		// the page's own markup reads it through page.data: not only the late island's
		expect(late_island_keys(svelte)).toEqual([]);
		expect(each_blocks('{#each post.data.tags as tag}<Tag {tag} />{/each}')).toEqual([
			{ line: 1, components: ['Tag'] }
		]);
	});

	it('a prop on the second line of a multi-line island tag is the island’s', () => {
		const svelte = [
			'<script>',
			"\timport R from './R.svelte' with { wake: 'visible' };",
			'</script>',
			'<R',
			'\treviews={data.reviews}',
			'/>'
		].join('\n');
		expect(late_island_keys(svelte)).toEqual([
			{ key: 'reviews', island: 'R', wake: 'visible', line: 5 }
		]);
	});

	it('a loop adding up its answers can run its calls together', () => {
		const q = '/x.ts';
		const code = ['let total = 0;', 'for (const id of ids) total += await price(id);'];
		const src = (p: string, a: number, b: number) =>
			p === q ? { start: a, lines: code.slice(a - 1, b) } : undefined;
		expect(needs_previous(src, q, 2, 2)).toBe(false);
	});
});

describe('formatter_rewrite', () => {
	it('literal arguments: one formatter at the top, used on the line', () => {
		expect(
			formatter_rewrite("\tconst rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });", {
				ts: true
			})!.after
		).toBe(
			"// at the top of the file (built once):\nconst RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });\n// the line:\n\tconst rtf = RELATIVE_TIME_FORMAT;"
		);
	});
	it('arguments that read variables: a cached factory, called in place of `new Intl.X(`', () => {
		const r = formatter_rewrite(
			"\treturn new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);",
			{ ts: false }
		)!;
		expect(r.after).toContain(
			'const number_format_cache = new Map();\nfunction number_format(locale, options) {'
		);
		expect(
			r.after.endsWith("\treturn number_format(locale, { style: 'currency', currency }).format(n);")
		).toBe(true);
	});
	it('localeCompare with literal locale and options: one collator', () => {
		expect(
			formatter_rewrite("\treturn a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });", {
				ts: true
			})!
				.after.split('\n')
				.pop()
		).toBe('\treturn COLLATOR.compare(a.name, b.name);');
		// a locale from a variable: not this shape
		expect(formatter_rewrite('\treturn a.localeCompare(b, lang);', { ts: true })).toBeUndefined();
		expect(formatter_rewrite('\treturn a + b;', { ts: true })).toBeUndefined();
	});
	const last = (s: string) => s.split('\n').pop();
	it('the receiver is the member chain only; a comma inside a call is not an argument break', () => {
		const lc = (l: string) => last(formatter_rewrite(l, { ts: false })!.after);
		expect(lc("\treturn x + a.name.localeCompare(b.name, 'de');")).toBe(
			'\treturn x + COLLATOR.compare(a.name, b.name);'
		);
		expect(lc("\treturn ok && row?.title.localeCompare(pick(b, 1), 'de');")).toBe(
			'\treturn ok && COLLATOR.compare(row?.title, pick(b, 1));'
		);
		expect(lc("\treturn -get(a, 0).label.localeCompare(b.label, 'de');")).toBe(
			'\treturn -COLLATOR.compare(get(a, 0).label, b.label);'
		);
		// a bracketed expression before it: not a plain chain, no rewrite
		expect(
			formatter_rewrite("\treturn (a || b).localeCompare(c, 'de');", { ts: false })
		).toBeUndefined();
		// no locale: no collator is built for it
		expect(formatter_rewrite('\treturn a.localeCompare(b);', { ts: false })).toBeUndefined();
		// optional chaining: `a.name?.localeCompare` is undefined when a.name is; not the same code
		expect(
			formatter_rewrite("\treturn a.name?.localeCompare(b.name, 'de');", { ts: false })
		).toBeUndefined();
	});
	it('every match on the line; none inside a string or a comment', () => {
		const r = formatter_rewrite(
			"\tconst s = `${new Intl.NumberFormat('en').format(a)}` + new Intl.NumberFormat('de').format(b); // new Intl.Collator()",
			{ ts: false }
		)!;
		// (the template's own match sits inside a string: left alone)
		expect(last(r.after)).toBe(
			"\tconst s = `${new Intl.NumberFormat('en').format(a)}` + NUMBER_FORMAT.format(b); // new Intl.Collator()"
		);
		const two = formatter_rewrite(
			"\tconst p = [new Intl.NumberFormat('en'), new Intl.NumberFormat('de')];",
			{ ts: false }
		)!;
		expect(two.after).toBe(
			"// at the top of the file (built once):\nconst NUMBER_FORMAT = new Intl.NumberFormat('en');\nconst NUMBER_FORMAT_2 = new Intl.NumberFormat('de');\n// the line:\n\tconst p = [NUMBER_FORMAT, NUMBER_FORMAT_2];"
		);
		expect(
			formatter_rewrite("\tconst s = 'new Intl.NumberFormat()';", { ts: false })
		).toBeUndefined();
	});
	it('names: never one the file uses; different arguments get different names; the same is reused', () => {
		const taken = new Set(['COLLATOR', 'x']);
		const made = new Map<string, string>();
		const a = formatter_rewrite("\treturn a.localeCompare(b, 'de');", { ts: false, taken, made })!;
		expect(a.after).toContain("const COLLATOR_2 = new Intl.Collator('de');");
		const b = formatter_rewrite("\treturn a.localeCompare(b, 'fr');", { ts: false, taken, made })!;
		expect(b.after).toContain("const COLLATOR_3 = new Intl.Collator('fr');");
		const c = formatter_rewrite("\treturn x.localeCompare(y, 'de');", { ts: false, taken, made })!;
		expect(c.after).toBe(
			'// uses COLLATOR_2, added by the change above\n// the line:\n\treturn COLLATOR_2.compare(x, y);'
		);
	});
	it('factory types: a locale list type, required options where Intl requires them; no factory for Locale', () => {
		const dn = formatter_rewrite(
			"\treturn new Intl.DisplayNames(locale, { type: 'region' }).of(c);",
			{ ts: true }
		)!;
		expect(dn.after).toContain(
			'function display_names(locale: Intl.LocalesArgument, options: Intl.DisplayNamesOptions) {'
		);
		const nf = formatter_rewrite('\treturn new Intl.NumberFormat(locale).format(n);', {
			ts: true
		})!;
		expect(nf.after).toContain(
			'function number_format(locale: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {'
		);
		expect(
			formatter_rewrite('\treturn new Intl.Locale(tag).language;', { ts: true })
		).toBeUndefined();
	});
	it('a component: the addition goes in <script module>, since the instance script runs per render', () => {
		expect(
			formatter_rewrite("\tconst f = new Intl.NumberFormat('en');", {
				ts: false,
				svelte: true
			})!.after.split('\n')[0]
		).toBe('// in `<script module>` (built once, not per render):');
	});
});

describe('promise_all_rewrite', () => {
	const src = [
		'\tconst term = x;',
		'',
		'\t// three calls',
		"\tconst user = await svc(origin, 'user', 30);",
		"\tconst cart = await svc(origin, 'cart', 25);",
		'\t// and one more',
		"\tconst { promos } = await span('p', () => svc(origin, 'promos', 20));",
		'\tconst other = 1;'
	];
	it('plain one-line awaits next to each other (comments between are fine) become one Promise.all', () => {
		expect(promise_all_rewrite(src, 1, [4, 5, 7])).toEqual({
			before: src.slice(3, 7).join('\n'),
			after:
				"\tconst [user, cart, { promos }] = await Promise.all([svc(origin, 'user', 30), svc(origin, 'cart', 25), span('p', () => svc(origin, 'promos', 20))]);"
		});
	});
	it('another statement between them: no rewrite (it could feed a later call)', () => {
		expect(
			promise_all_rewrite(
				[...src.slice(0, 5), '\tconst id = cart.id;', ...src.slice(6)],
				1,
				[4, 5, 7]
			)
		).toBeUndefined();
	});
	it('any other shape of line: no rewrite', () => {
		const ok = "\tconst b = await get('b');";
		const bad = [
			// a type on the binding
			"\tconst a: User = await get('a');",
			// two names
			"\tconst a = await get('a'), c = 1;",
			// a second statement
			"\tconst a = await get('a'); log(a);",
			// something done to the answer
			"\tconst a = await get('a') + 1;",
			"\tconst a = await get('a') || fallback;",
			"\tconst a = await get('a') ?? fallback;",
			'\tconst a = await flag;',
			// an await inside: it would still wait, in the array
			"\tconst a = await (await fetch('/a')).json();",
			// a write: two started together can land in either order
			"\tconst a = await db.insert('row');",
			'\tconst a = await saveCart(cart);',
			"\tconst a = await fetch('/a', { method: 'POST' });"
		];
		for (const l of bad) expect(promise_all_rewrite([l, ok], 1, [1, 2]), l).toBeUndefined();
	});
	it('a trailing comment, a let, and names that only look like verbs are fine', () => {
		expect(
			promise_all_rewrite(
				[
					"\tlet a = await settings('https://x.test/a'); // the settings",
					"\tconst b = await posts('b');"
				],
				1,
				[1, 2]
			)
		).toEqual({
			before:
				"\tlet a = await settings('https://x.test/a'); // the settings\n\tconst b = await posts('b');",
			after: "\tlet [a, b] = await Promise.all([settings('https://x.test/a'), posts('b')]);"
		});
	});
	it('an await spread over several lines: no rewrite', () => {
		expect(
			promise_all_rewrite(
				['\tconst a = await get(', '\t\t1);', '\tconst b = await get(2);'],
				1,
				[1, 3]
			)
		).toBeUndefined();
	});
});

describe('load_inputs', () => {
	it('what a load takes from the request', () => {
		expect(
			load_inputs('export const load: PageServerLoad = async ({ url, fetch }) => {\n};')
		).toEqual(['url', 'fetch']);
		expect(
			load_inputs('export async function load({\n\tcookies,\n\tlocals: { user }\n}) {}')
		).toEqual(['cookies', 'locals']);
		// the whole event in one name: it may read anything
		expect(
			load_inputs('export const load = async (event) => ({ a: event.cookies.get("x") });')
		).toEqual(['*event']);
		expect(load_inputs('export const load = async () => ({ a: 1 });')).toEqual([]);
		expect(load_inputs('export const prerender = true;')).toBeNull();
		// wrapped for `satisfies`: the arrow's own parameters, not `async`
		expect(
			load_inputs(
				'export const load = (async ({ url }) => {\n\treturn {};\n}) satisfies PageServerLoad;'
			)
		).toEqual(['url']);
		expect(load_inputs('export const load = async event => ({});')).toEqual(['*event']);
	});
});

describe('parent_use', () => {
	it('what the page took from parent(), and the first line that reads it', () => {
		const src = [
			'export const load = async ({ parent }) => {',
			'\tconst { session } = await parent();',
			"\tconst pricing = await get('pricing');",
			"\tconst stock = await get('stock');",
			'\treturn {',
			'\t\tpricing,',
			'\t\tsession',
			'\t};',
			'};'
		].join('\n');
		expect(parent_use(src)).toEqual({
			line: 2,
			names: ['session'],
			first_use: 7,
			awaits_before_use: 2
		});
		// used right away: nothing waited for nothing
		expect(
			parent_use(
				'export const load = async ({ parent }) => {\n\tconst { user } = await parent();\n\tconst x = await get(user.id);\n\treturn { x };\n};'
			)
		).toMatchObject({ first_use: 3, awaits_before_use: 0 });
		expect(parent_use('export const load = async () => ({ a: 1 });')).toBeNull();
	});
});

describe('line_rw', () => {
	it('what a line writes and what it reads', () => {
		expect(line_rw('const { a, b: c } = await get(x, y.z);')).toEqual({
			reads: ['get', 'x', 'y'],
			writes: ['a', 'c'],
			declared: ['a', 'c'],
			accum: []
		});
		// a filled receiver is written, not read; the loop's `p` is declared (fresh every turn)
		expect(line_rw('for (const p of rows) stock.push(await stockOf(origin, p.id));')).toMatchObject(
			{ writes: ['p', 'stock'], declared: ['p'], reads: ['rows', 'stockOf', 'origin', 'p'] }
		);
		// `x += …` reads x; `x = …` does not
		expect(line_rw('total += price(n);')).toMatchObject({
			writes: ['total'],
			reads: ['total', 'price', 'n']
		});
		expect(line_rw('cursor = (await page(cursor)).next;')).toMatchObject({
			writes: ['cursor'],
			reads: ['page', 'cursor']
		});
		expect(line_rw('const ids = rows.map((r) => r.id);').reads).toEqual(['rows']);
	});
});

describe('tag_fills', () => {
	it('a wait whose calling line feeds only unread keys says so', () => {
		const root: DrillNode = {
			label: 'render',
			ms: 30,
			kind: 'render',
			children: [
				{
					label: 'load functions',
					ms: 30,
					kind: 'phase',
					children: [
						{
							label: 'GET /live',
							ms: 15,
							kind: 'wait',
							children: [
								{
									label: 'load (routes/x/+page.server.ts:7)',
									ms: 15,
									kind: 'line',
									at: 'routes/x/+page.server.ts:7'
								}
							]
						},
						// through a helper: the helper line, then the load line that called it
						{
							label: 'GET /nav',
							ms: 15,
							kind: 'wait',
							children: [
								{
									label: 'svc (routes/x/+page.server.ts:40)',
									ms: 15,
									kind: 'line',
									at: 'routes/x/+page.server.ts:40',
									children: [
										{ label: 'load (x:6)', ms: 15, kind: 'line', at: 'routes/x/+page.server.ts:6' }
									]
								}
							]
						}
					]
				}
			]
		};
		tag_fills(root, [
			{ key: 'live_at', from: 'routes/x/+page.server.ts', lines: [4, 7, 24], verdict: 'unread' },
			{ key: 'services', from: 'routes/x/+page.server.ts', lines: [4, 6, 25], verdict: 'server' }
		]);
		const rows = root.children![0].children!;
		expect(rows[0].fills).toEqual([{ key: 'live_at', read: false }]);
		expect(rows[1].fills).toEqual([{ key: 'services', read: true }]);
	});

	it('a helper inlined into the load: the owner mixes lines, and the line row still says what it fills', () => {
		const root: DrillNode = {
			label: 'render',
			ms: 90,
			kind: 'render',
			children: [
				{
					label: 'load',
					ms: 90,
					kind: 'cpu',
					at: 'routes/x/+page.server.ts:64',
					children: [
						{ label: 'x:98', ms: 55, kind: 'line', at: 'src/routes/x/+page.server.ts:98' },
						{ label: 'x:94', ms: 34, kind: 'line', at: 'src/routes/x/+page.server.ts:94' },
						// a line of another file: no key of this load
						{ label: 'c:46', ms: 1, kind: 'line', at: 'src/lib/c.ts:46' }
					]
				}
			]
		};
		tag_fills(root, [
			{ key: 'freshest', from: 'routes/x/+page.server.ts', lines: [98, 120], verdict: 'unread' },
			{ key: 'results', from: 'routes/x/+page.server.ts', lines: [94, 110], verdict: 'server' }
		]);
		const load = root.children![0];
		// the owner's lines are not all one key's (one feeds nothing known): no verdict for it
		expect(load.fills).toBeUndefined();
		expect(load.children!.map((c) => c.fills)).toEqual([
			[{ key: 'freshest', read: false }],
			[{ key: 'results', read: true }],
			undefined
		]);
		expect(unread_rows(root)).toMatchObject([{ label: 'x:98', ms: 55, keys: ['freshest'] }]);
	});

	it("a helper's CPU under a load file, with no load line of its own, goes by the name the key's lines use", () => {
		const root: DrillNode = {
			label: 'render',
			ms: 60,
			kind: 'render',
			children: [
				{
					label: 'load functions',
					ms: 60,
					kind: 'phase',
					children: [
						{
							label: 'routes/x/+page.server.ts',
							ms: 60,
							kind: 'lane',
							at: 'routes/x/+page.server.ts',
							children: [
								{ label: 'newestReview', ms: 50, kind: 'cpu', at: 'src/lib/format.ts:23' },
								{ label: 'byName', ms: 10, kind: 'cpu', at: 'src/lib/format.ts:17' }
							]
						}
					]
				}
			]
		};
		tag_fills(root, [
			{
				key: 'freshest',
				from: 'routes/x/+page.server.ts',
				lines: [90, 117],
				names: ['valid', 'newestReview', 'freshest'],
				verdict: 'unread'
			},
			{
				key: 'results',
				from: 'routes/x/+page.server.ts',
				lines: [88, 106],
				names: ['hits', 'byName', 'results'],
				verdict: 'server'
			},
			// another load's key naming the same function is not this lane's
			{
				key: 'other',
				from: 'routes/y/+page.server.ts',
				lines: [5],
				names: ['newestReview'],
				verdict: 'server'
			}
		]);
		const [a, b] = root.children![0].children![0].children!;
		expect(a.fills).toEqual([{ key: 'freshest', read: false }]);
		expect(b.fills).toEqual([{ key: 'results', read: true }]);
		// the work for nothing: only the row whose every key is unread
		expect(unread_rows(root)).toEqual([
			{ label: 'newestReview', ms: 50, kind: 'cpu', keys: ['freshest'], at: 'src/lib/format.ts:23' }
		]);
	});
});
