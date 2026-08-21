import { beforeEach, describe, expect, it } from 'vitest';

// Turn the compile gate ON for this suite BEFORE importing the bus — the module-local
// `const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? … : false` reads the identifier at
// import time, and a bare identifier resolves off `globalThis`. In a real app the Vite `define`
// replaces the token instead; here we simulate "devtools build on".
(globalThis as unknown as { __OGYGIA_DEVTOOLS__: boolean }).__OGYGIA_DEVTOOLS__ = true;

const { DEVTOOLS, emit, snapshot, clear, add_sink, configure } = await import(
	'../src/devtools/bus.js'
);
const { install_console_sink, to_trace } = await import('../src/devtools/sinks.js');
const { DEVTOOLS_SCHEMA_VERSION } = await import('../src/devtools/schema.js');

beforeEach(() => {
	clear();
	configure({ active: true, cap: 4096 });
});

describe('devtools bus — gate', () => {
	it('is enabled in this suite (globalThis token read at import)', () => {
		expect(DEVTOOLS).toBe(true);
	});
});

describe('devtools bus — emit + buffer', () => {
	it('stamps the envelope (v / seq / t / realm) on every event', () => {
		emit({ domain: 'runtime', name: 'runtime.boot', features: ['router'] });
		const [ev] = snapshot();
		expect(ev.v).toBe(DEVTOOLS_SCHEMA_VERSION);
		expect(typeof ev.seq).toBe('number');
		expect(typeof ev.t).toBe('number');
		expect(ev.realm).toBe('server'); // no window in the vitest node env
		expect(ev.domain).toBe('runtime');
		expect(ev.name).toBe('runtime.boot');
	});

	it('buffers in emission order with a monotonic seq', () => {
		emit({ domain: 'hub', name: 'hub.mint', kind: 'wire', id: 'a' });
		emit({ domain: 'hub', name: 'hub.mint', kind: 'wire', id: 'b' });
		emit({ domain: 'hub', name: 'hub.mint', kind: 'wire', id: 'c' });
		const ids = snapshot()
			.filter((e) => e.name === 'hub.mint')
			.map((e) => (e as { id: string }).id);
		expect(ids).toEqual(['a', 'b', 'c']);
		const seqs = snapshot().map((e) => e.seq);
		for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
	});

	it('rings the buffer at capacity — newest kept, oldest dropped', () => {
		configure({ cap: 3 });
		for (let i = 0; i < 6; i++)
			emit({ domain: 'hub', name: 'hub.mint', kind: 'wire', id: String(i) });
		const ids = snapshot().map((e) => (e as { id: string }).id);
		expect(ids).toEqual(['3', '4', '5']);
	});
});

describe('devtools bus — sinks', () => {
	it('delivers to a registered sink and stops after unregister', () => {
		const seen: string[] = [];
		const off = add_sink((e) => seen.push(e.name));
		emit({ domain: 'nav', name: 'nav.batch', count: 2 });
		off();
		emit({ domain: 'nav', name: 'nav.batch', count: 3 });
		expect(seen).toEqual(['nav.batch']);
	});

	it('contains a throwing sink — the framework path never breaks', () => {
		const seen: string[] = [];
		add_sink(() => {
			throw new Error('bad sink');
		});
		add_sink((e) => seen.push(e.name));
		expect(() => emit({ domain: 'nav', name: 'nav.batch', count: 1 })).not.toThrow();
		expect(seen).toEqual(['nav.batch']);
	});

	it('console sink honours its filter', () => {
		const logged: string[] = [];
		const orig = console.debug;
		console.debug = (...args: unknown[]) => {
			logged.push(String(args[0]));
		};
		try {
			const off = install_console_sink((e) => e.domain === 'nav');
			emit({ domain: 'nav', name: 'nav.batch', count: 1 });
			emit({ domain: 'hub', name: 'hub.mint', kind: 'wire', id: 'x' });
			off();
			expect(logged.length).toBe(1);
			expect(logged[0]).toContain('nav.nav.batch');
		} finally {
			console.debug = orig;
		}
	});
});

describe('devtools bus — sampling + pause', () => {
	it('keeps 1-in-N for a sampled event name', () => {
		configure({ sample: { 'hub.resolve': 3 } });
		for (let i = 0; i < 9; i++)
			emit({ domain: 'hub', name: 'hub.resolve', kind: 'wire', id: String(i), scope: 'page', hit: false });
		const kept = snapshot().filter((e) => e.name === 'hub.resolve');
		expect(kept.length).toBe(3);
	});

	it('emits nothing while paused', () => {
		configure({ active: false });
		emit({ domain: 'nav', name: 'nav.batch', count: 1 });
		expect(snapshot().length).toBe(0);
		configure({ active: true });
	});
});

describe('devtools trace', () => {
	it('serializes a versioned, JSON-safe trace', () => {
		emit({ domain: 'runtime', name: 'region.connected', entry: 'x', deferred: false, nested: false });
		const trace = to_trace();
		expect(trace.kind).toBe('ogygia-devtools-trace');
		expect(trace.version).toBe(DEVTOOLS_SCHEMA_VERSION);
		// Round-trips through JSON with no loss (the trace format is a public artifact).
		const round = JSON.parse(JSON.stringify(trace));
		expect(round.events.length).toBe(trace.events.length);
		expect(round.events.at(-1).name).toBe('region.connected');
	});
});
