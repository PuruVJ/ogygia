// The page the Page tab and `page()` report from is the one the router last SWAPPED in. A navigation
// that started and never finished — it fell back to a full load a test held back (204), or a later
// one overtook it — changed nothing, and must not cut the report to "since then" (it emptied the
// islands of a page that never left).
import { beforeEach, describe, expect, it } from 'vitest';

(globalThis as unknown as { __OGYGIA_DEVTOOLS__: boolean }).__OGYGIA_DEVTOOLS__ = true;

const { ingest, clear, configure } = await import('@ogygia/core/events');
const { last_nav } = await import('../src/devtools/page.ts');
import type { DevtoolsEvent } from '@ogygia/core/events';

let seq = 0;
const ev = (name: 'nav.start' | 'nav.finish', t: number, to: string) =>
	({
		domain: 'nav',
		name,
		to,
		from: '/',
		type: 'link',
		ms: 1,
		reconciled: true,
		vt: false,
		v: 1,
		seq: seq++,
		t,
		realm: 'client'
	}) as unknown as DevtoolsEvent;

beforeEach(() => {
	clear();
	configure({ active: true, cap: 4096 });
});

describe('last_nav', () => {
	it('a navigation that finished: its start, its address', () => {
		ingest([ev('nav.start', 100, '/b'), ev('nav.finish', 180, '/b')]);
		expect(last_nav()).toEqual({ to: '/b', t: 100 });
	});
	it('one that started and never finished changes nothing', () => {
		ingest([ev('nav.start', 100, '/login')]);
		expect(last_nav()).toBe(null);
		ingest([
			ev('nav.start', 100, '/b'),
			ev('nav.finish', 180, '/b'),
			ev('nav.start', 900, '/login')
		]);
		expect(last_nav()).toEqual({ to: '/b', t: 100 });
	});
	it('an overtaken navigation is not the page: the one that finished is', () => {
		ingest([ev('nav.start', 100, '/a'), ev('nav.start', 150, '/b'), ev('nav.finish', 220, '/b')]);
		expect(last_nav()).toEqual({ to: '/b', t: 150 });
	});
});
