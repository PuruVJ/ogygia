import { describe, it, expect } from 'vitest';
import { analyze_cpu, clean_file, kind_of, fn_label, type SelfProfileTrace } from '../src/devtools/cpu.js';

const PAGE = 'http://127.0.0.1:4183/dt-lab';
const R = {
	heavy: 'http://127.0.0.1:4183/src/lib/dtlab/Heavy.svelte?t=1',
	svelte: 'http://127.0.0.1:4183/node_modules/.vite/deps/svelte_internal_client.js?v=abc',
	runtime: 'http://127.0.0.1:4183/@fs/Users/x/sk/packages/ogygia/src/runtime/core.ts',
	beacon: 'http://127.0.0.1:4183/@fs/Users/x/sk/packages/ogygia/src/runtime/beacon.ts',
	lib: 'http://127.0.0.1:4183/node_modules/.vite/deps/@codemirror_view.js?v=1'
};

// frames: 0 Heavy (Heavy.svelte:11), 1 run (svelte), 2 boot (runtime), 3 loop (inline page script), 4 make_profiler (beacon), 5 draw (dep)
function trace(): SelfProfileTrace {
	const resources = [R.heavy, R.svelte, R.runtime, PAGE, R.beacon, R.lib];
	const frames = [
		{ name: 'Heavy', resourceId: 0, line: 11 },
		{ name: 'run', resourceId: 1, line: 5 },
		{ name: 'boot', resourceId: 2, line: 40 },
		{ name: '', resourceId: 3, line: 16 },
		{ name: 'make_profiler', resourceId: 4, line: 355 },
		{ name: 'draw', resourceId: 5, line: 9 }
	];
	// stacks: 0 boot, 1 boot>run, 2 boot>run>Heavy, 3 loop, 4 make_profiler, 5 draw
	const stacks = [{ frameId: 2 }, { frameId: 1, parentId: 0 }, { frameId: 0, parentId: 1 }, { frameId: 3 }, { frameId: 4 }, { frameId: 5 }];
	const samples: SelfProfileTrace['samples'] = [];
	let t = 0;
	const at = (n: number, stackId?: number) => {
		for (let i = 0; i < n; i++) samples.push({ timestamp: (t += 10), ...(stackId !== undefined ? { stackId } : {}) });
	};
	at(2, 4); // 20 ms: the sampler's own start (t 10–20)
	at(3, 1); // 30 ms: svelte run under boot (t 30–50)
	at(14, 2); // 140 ms: Heavy inside its hydrate window (t 60–190)
	at(5); // idle
	at(22, 3); // 220 ms: the page script's loop, a long task (t 250–460)
	at(1, 5);
	return { frames, resources, samples, stacks };
}

describe('clean_file / kind_of', () => {
	it('reads Vite dev URLs', () => {
		expect(clean_file(R.heavy, 'http://127.0.0.1:4183')).toBe('src/lib/dtlab/Heavy.svelte');
		expect(clean_file(R.runtime, 'http://127.0.0.1:4183')).toBe('ogygia/src/runtime/core.ts');
		expect(clean_file(R.svelte, 'http://127.0.0.1:4183')).toBe('svelte_internal_client.js');
		expect(kind_of(R.heavy, PAGE)).toBe('app');
		expect(kind_of(R.svelte, PAGE)).toBe('svelte');
		expect(kind_of(R.runtime, PAGE)).toBe('ogygia');
		expect(kind_of(R.beacon, PAGE)).toBe('devtools');
		expect(kind_of(R.lib, PAGE)).toBe('dependency');
		expect(kind_of(PAGE, PAGE)).toBe('page script');
		expect(kind_of('', PAGE)).toBe('browser');
	});
});

describe('analyze_cpu', () => {
	const s = analyze_cpu(trace(), [{ fp: 'heavy', from: 55, to: 195 }], [{ t: 245, ms: 220 }], PAGE);

	it('adds busy time by kind, skipping idle samples', () => {
		const by = Object.fromEntries(s.by_kind.map((k) => [k.kind, k.ms]));
		expect(by.app).toBe(140);
		expect(by['page script']).toBe(220);
		expect(by.svelte).toBe(30);
		expect(by.devtools).toBe(20);
		expect(s.interval_ms).toBe(10);
	});

	it('names the functions, with the measuring itself left out of the top list', () => {
		expect(s.fns[0]).toMatchObject({ file: '/dt-lab', line: 16, kind: 'page script', self_ms: 220 });
		expect(s.fns.find((f) => f.name === 'make_profiler')).toBeUndefined();
		const boot = s.fns.find((f) => f.name === 'boot');
		expect(boot).toBeUndefined(); // no self time
		const heavy = s.fns.find((f) => f.name === 'Heavy')!;
		expect(fn_label(heavy)).toBe('Heavy (Heavy.svelte:11)');
	});

	it('attributes CPU to the island whose hydrate window it fell in, and long tasks outside', () => {
		expect(s.islands.heavy.ms).toBe(140);
		expect(s.islands.heavy.top[0].name).toBe('Heavy');
		expect(s.outside.ms).toBe(220);
		expect(s.outside.top[0].file).toBe('/dt-lab');
	});

	it('a stall between samples is not all CPU', () => {
		const t = trace();
		t.samples.push({ timestamp: t.samples[t.samples.length - 1].timestamp + 5000, stackId: 5 });
		const s2 = analyze_cpu(t, [], [], PAGE);
		const dep = s2.by_kind.find((k) => k.kind === 'dependency')!;
		expect(dep.ms).toBeLessThanOrEqual(40); // capped at 3 intervals, not 5 s
	});
});
