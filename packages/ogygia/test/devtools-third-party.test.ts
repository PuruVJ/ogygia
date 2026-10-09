// Third parties, from what the browser measured: other origins' bytes and blocking files, their
// main-thread time, the scripts other scripts loaded, and the islands they could have edited. And
// an island's children slot the server never filled.
import { expect, test } from 'vitest';
import { kind_of_host, third_party, third_party_findings } from '../src/devtools/third-party.js';
import { analyze_page } from '../src/devtools/page-insights.js';

const res = (url: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({ url, type: 'script', start, end, size: 20_000, transfer: 7000, ...extra });
const resources = [
	res('https://app.test/_app/a.js', 10, 30),
	res('https://www.googletagmanager.com/gtm.js?id=X', 20, 60),
	res('https://tags.example.net/blocking.js', 5, 50, { blocking: true }),
	// loaded by a script: after the HTML was parsed (200) and after a third-party script ran
	res('https://www.google-analytics.com/g.js', 300, 320, { size: 80_000 }),
	res('https://px.example.org/p.js', 310, 330)
];

test('by origin: kinds, bytes, blocking, runtime-loaded, main-thread time', () => {
	const tp = third_party(resources, 'https://app.test', new Map([['www.googletagmanager.com', 180]]), undefined, 200)!;
	expect(tp.origins.map((o) => o.host)).not.toContain('app.test');
	expect(tp.origins[0]).toMatchObject({ host: 'www.googletagmanager.com', kind: 'tag manager', cpu_ms: 180 });
	expect(tp.blocking).toBe(1);
	expect(tp.runtime_loaded).toBe(2);
	expect(kind_of_host('static.hotjar.com')).toBe('session replay');
	expect(kind_of_host('nothing-known.dev')).toBe('other');
	// the server's HTML named one of the late ones: only the other came at runtime
	expect(third_party(resources, 'https://app.test', null, new Set(['https://www.google-analytics.com/g.js']))!.runtime_loaded).toBe(1);
	// the live page: a library whose parts no element names, imported before parsing ended, is
	// counted; the element the page names is not, and an element a script added late still is
	const lib = [res('https://cdn.lib.test/lib.js', 5, 20), res('https://cdn.lib.test/p-1.js', 21, 30), res('https://cdn.lib.test/p-2.js', 22, 31), res('https://tags.test/added.js', 400, 410)];
	expect(third_party(lib, 'https://app.test', null, undefined, 200, new Set(['https://cdn.lib.test/lib.js', 'https://tags.test/added.js']))!.runtime_loaded).toBe(3);
	expect(third_party(lib, 'https://app.test', null, undefined, 200)!.runtime_loaded).toBe(1);
});

test('findings: the heaviest with a fix per kind, the blocking origin, the island a third party could have edited', () => {
	const tp = third_party(resources, 'https://app.test', new Map([['www.googletagmanager.com', 180]]), undefined, 200);
	const f = third_party_findings(tp, [{ name: 'Menu', done: 400 }]);
	const main = f.find((x) => x.code === 'third-party')!;
	expect(main.message).toContain('ran 180 ms on the main thread');
	expect(main.message).toContain('2 of their scripts the page never names');
	expect(main.fix).toContain('tag manager: audit its tags');
	expect(f.find((x) => x.code === 'third-party-blocking')?.message).toContain('tags.example.net');
	expect(f.find((x) => x.code === 'third-party-edits')?.message).toContain('Menu did not wake from the server');
	// an island that woke before any third party ran: no third party is suspected
	expect(third_party_findings(tp, [{ name: 'Menu', done: 1 }]).some((x) => x.code === 'third-party-edits')).toBe(false);
	// a light, async third party is not a finding
	expect(third_party_findings(third_party([res('https://cdn.x.io/t.js', 5, 6, { size: 900 })], 'https://app.test', null))).toEqual([]);
});

test('a browser that hides other origins\' sizes: scripts counted, never called 0 KB', () => {
	// every file 0 bytes, as one engine reports them even with Timing-Allow-Origin
	const lib = Array.from({ length: 12 }, (_, i) => res(`https://cdn.lib.test/p-${i}.js`, 10 + i, 20 + i, { size: 0, transfer: 0 }));
	const tp = third_party(lib, 'https://app.test', null)!;
	expect(tp).toMatchObject({ script_bytes: 0, unsized: 12 });
	const main = third_party_findings(tp).find((x) => x.code === 'third-party')!;
	expect(main.message).toContain('served 12 scripts (this browser hides');
	expect(main.message).toContain('cdn.lib.test 12 scripts, sizes hidden');
	expect(main.message).not.toContain('0 KB');
	// some sized, some hidden: a floor, not a total
	const mixed = third_party_findings(third_party([...lib.slice(0, 6), res('https://cdn.lib.test/big.js', 40, 50, { size: 40_000 })], 'https://app.test', null))[0];
	expect(mixed.message).toContain('at least 39 KB of JS (6 of the 7 scripts had their size hidden');
	// a couple of hidden scripts alone are not worth a finding
	expect(third_party_findings(third_party(lib.slice(0, 2), 'https://app.test', null))).toEqual([]);
});

test('an awake island with an empty children slot is named', () => {
	const r = analyze_page(
		{ vitals: {}, visit: null, islands: [], firsts: [], shifts: [], longtasks: [], empty_slots: ['aaaaaaaa11111111', 'aaaaaaaa11111111'] },
		[{ fp: 'aaaaaaaa11111111', name: 'Drawer', kind: 'island', wake: 'load', hydrated: true }]
	);
	const f = r.findings.find((x) => x.code === 'empty-slot')!;
	expect(f.message).toContain('Drawer shows its children in a slot with nothing in it');
	expect(f.fps).toEqual(['aaaaaaaa11111111']);
});
