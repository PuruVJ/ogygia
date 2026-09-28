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

test('an awake island with an empty children slot is named', () => {
	const r = analyze_page(
		{ vitals: {}, visit: null, islands: [], firsts: [], shifts: [], longtasks: [], empty_slots: ['aaaaaaaa11111111', 'aaaaaaaa11111111'] },
		[{ fp: 'aaaaaaaa11111111', name: 'Drawer', kind: 'island', wake: 'load', hydrated: true }]
	);
	const f = r.findings.find((x) => x.code === 'empty-slot')!;
	expect(f.message).toContain('Drawer shows its children in a slot with nothing in it');
	expect(f.fps).toEqual(['aaaaaaaa11111111']);
});
