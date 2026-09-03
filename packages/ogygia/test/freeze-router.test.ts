/**
 * FREEZE × the programmatic router — `page(C, { freeze })` / `layout(name, C, { freeze })` /
 * `routes(table, { freeze })` cascade, and the registry the handle consults for requests Kit's
 * file router never claimed. Verdict grammar: `undefined` = not this table's · `null` = claimed,
 * nothing declared (config default) · boolean = declared, deepest wins.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { routes, page, layout } from '../src/router/index.js';
import { router_freeze_verdict, clear_freeze_routers } from '../src/freeze/routers.js';

const C = (() => null) as never;

beforeEach(() => clear_freeze_routers());

describe('freeze × programmatic router', () => {
	it('an undeclared page is claimed-but-undeclared (null); an unmatched path is nobody’s (undefined)', () => {
		routes({ '/a': page(C) });
		expect(router_freeze_verdict('/a')).toBe(null);
		expect(router_freeze_verdict('/nope')).toBe(undefined);
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
		expect(router_freeze_verdict('/on')).toBe(true); // from the layout
		expect(router_freeze_verdict('/off')).toBe(false); // the page overrides its layout
		expect(router_freeze_verdict('/tbl')).toBe(false); // the table default
	});

	it('nested layouts: the innermost declaration wins over an outer one', () => {
		const outer = layout('outer', C, { freeze: false });
		const inner = layout('inner', C, { freeze: true });
		routes({ ...outer({ ...inner({ '/x': page(C) }) }) });
		expect(router_freeze_verdict('/x')).toBe(true);
	});

	it('a `base` is stripped before matching; a path outside it is not this table’s', () => {
		routes({ '/p': page(C, { freeze: true }) }, { base: '/r' });
		expect(router_freeze_verdict('/r/p')).toBe(true);
		expect(router_freeze_verdict('/p')).toBe(undefined);
	});

	it('dynamic patterns match like dispatch', () => {
		routes({ '/docs/[slug]': page(C, { freeze: true }) });
		expect(router_freeze_verdict('/docs/intro')).toBe(true);
	});

	it('endpoints are not pages: claimed, undeclared (null)', () => {
		routes({ '/api': { GET: () => new Response('x') } as never });
		expect(router_freeze_verdict('/api')).toBe(null);
	});

	it('re-registering the same table REPLACES its matcher (dev re-evaluation), never shadows it', () => {
		routes({ '/a': page(C, { freeze: false }) });
		routes({ '/a': page(C, { freeze: true }) });
		expect(router_freeze_verdict('/a')).toBe(true);
	});

	it('two mounted tables: the one that claims the path answers', () => {
		routes({ '/a': page(C, { freeze: true }) }, { base: '/one' });
		routes({ '/a': page(C, { freeze: false }) }, { base: '/two' });
		expect(router_freeze_verdict('/one/a')).toBe(true);
		expect(router_freeze_verdict('/two/a')).toBe(false);
	});
});
