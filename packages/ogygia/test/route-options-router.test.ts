/**
 * ROUTE OPTIONS × the programmatic router — `page(C, { freeze })` / `layout(name, C, { freeze })` /
 * `routes(table, { freeze })` cascade, registered with the generic route-option registry the
 * handle consults (plugin/routes.ts). Matcher grammar: `undefined` = not this table's · `null` =
 * claimed, nothing declared · boolean = declared, deepest wins. `route_option` folds the first two
 * into `undefined` (the plugin's default applies), but a claiming table still SHADOWS the file
 * world: dispatch would answer from the table, never from a Kit page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { routes, page, layout } from '../src/router/index.ts';
import { route_option, clear_route_options, set_page_route_options } from '../src/plugin/routes.ts';

const C = (() => null) as never;
const freeze = (path: string) => route_option('freeze', null, path);

beforeEach(() => clear_route_options());

describe('route options × programmatic router', () => {
	it('an undeclared page and an unmatched path both answer undefined (the default applies)', () => {
		routes({ '/a': page(C) });
		expect(freeze('/a')).toBe(undefined);
		expect(freeze('/nope')).toBe(undefined);
		// the plugin's default fills both
		expect(freeze('/a') ?? true).toBe(true);
		expect(freeze('/a') ?? false).toBe(false);
	});

	it('a claimed-but-undeclared path shadows the file world; an unclaimed one falls through to it', () => {
		set_page_route_options({ '/a': { freeze: true }, '/kit': { freeze: true } });
		routes({ '/a': page(C) });
		expect(route_option('freeze', '/a', '/a')).toBe(undefined); // the table claims /a
		expect(route_option('freeze', '/kit', '/kit')).toBe(true); // nobody claims /kit
	});

	it('page > layout > table — the deepest declaration wins', () => {
		const shell = layout('shell', C, { freeze: true });
		routes(
			{
				...shell({ '/on': page(C), '/off': page(C, { freeze: false }) }),
				'/tbl': page(C)
			},
			{ freeze: false }
		);
		expect(freeze('/on')).toBe(true); // from the layout
		expect(freeze('/off')).toBe(false); // the page overrides its layout
		expect(freeze('/tbl')).toBe(false); // the table default
	});

	it('nested layouts: the innermost declaration wins over an outer one', () => {
		const outer = layout('outer', C, { freeze: false });
		const inner = layout('inner', C, { freeze: true });
		routes({ ...outer({ ...inner({ '/x': page(C) }) }) });
		expect(freeze('/x')).toBe(true);
	});

	it('a `base` is stripped before matching; a path outside it is not this table’s', () => {
		routes({ '/p': page(C, { freeze: true }) }, { base: '/r' });
		expect(freeze('/r/p')).toBe(true);
		expect(freeze('/p')).toBe(undefined);
	});

	it('dynamic patterns match like dispatch', () => {
		routes({ '/docs/[slug]': page(C, { freeze: true }) });
		expect(freeze('/docs/intro')).toBe(true);
	});

	it('endpoints are not pages: claimed, undeclared, whatever the table says', () => {
		routes({ '/api': { GET: () => new Response('x') } as never }, { freeze: true });
		expect(freeze('/api')).toBe(undefined);
	});

	it('an option the router does not declare answers undefined on a claimed page', () => {
		routes({ '/a': page(C, { freeze: true }) });
		expect(route_option('somethingElse', null, '/a')).toBe(undefined);
	});

	it('re-registering the same table REPLACES its matcher (dev re-evaluation), never shadows it', () => {
		routes({ '/a': page(C, { freeze: false }) });
		routes({ '/a': page(C, { freeze: true }) });
		expect(freeze('/a')).toBe(true);
	});

	it('two mounted tables: the one that claims the path answers', () => {
		routes({ '/a': page(C, { freeze: true }) }, { base: '/one' });
		routes({ '/a': page(C, { freeze: false }) }, { base: '/two' });
		expect(freeze('/one/a')).toBe(true);
		expect(freeze('/two/a')).toBe(false);
	});
});
