// `flag()` — the ONE decision primitive. A kill switch, a rollout, a targeting rule, and an
// A/B/n test are the same thing, read by CALLING the flag; `.pick()` branches (page slot OR value
// map); `.value()` reads a vendor payload; `decide()` wires the source / overrides / exposure.
// These tests pin: the four declaration shapes, the decision chain (override → carried → source →
// native → control), stickiness, pick both forms, value+schema, layers, exposure batching, and
// the federation auto-carry contract.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	flag,
	decide,
	flush_exposures,
	prime_flags,
	assigned_buckets,
	type FlagSource
} from '../src/flags.js';
import type { StandardSchemaV1 } from '../src/router/view.js';

const CLAIMS = Symbol.for('ogygia.claims.v1');

// overrides are DEV-gated; open them so tests don't depend on the runner's esm-env DEV resolution.
beforeEach(() => decide({ overrides: () => true, source: undefined, exposure: undefined }));

function ctx(
	url = 'http://s/x',
	opts: { vid?: string; claims?: Record<string, unknown>; sub?: string } = {}
) {
	const request = new Request(url);
	if (opts.claims) (request as unknown as Record<symbol, unknown>)[CLAIMS] = opts.claims;
	return {
		request,
		url: new URL(url),
		cookies: { get: (n: string) => (n === 'og-vid' ? opts.vid : undefined) },
		...(opts.sub ? { visitor: { sub: opts.sub } } : {})
	};
}

describe('flag — the four declaration shapes, read by calling', () => {
	it('bare = a kill switch, off for everyone', () => {
		const f = flag('bare');
		expect(f(ctx())).toBe(false);
		expect(f(ctx('http://s/x', { vid: 'v1' }))).toBe(false);
	});

	it('number = sticky rollout percent, ~accurate over a population', () => {
		const f = flag('roll', 10);
		const one = ctx('http://s/x', { vid: 'v-7' });
		expect(f(one)).toBe(f(one)); // deterministic
		let hits = 0;
		for (let i = 0; i < 2000; i++) if (f(ctx('http://s/x', { vid: `v${i}` }))) hits++;
		expect(hits / 2000).toBeGreaterThan(0.07);
		expect(hits / 2000).toBeLessThan(0.13);
	});

	it('function = targeting; true → on, false → definitively off, undefined → fall through', () => {
		const f = flag('beta', (c) => {
			const sub = c.visitor?.sub;
			return sub === 'beta' ? true : sub === 'blocked' ? false : undefined;
		});
		expect(f(ctx('http://s/x', { sub: 'beta' }))).toBe(true);
		expect(f(ctx('http://s/x', { sub: 'blocked' }))).toBe(false);
		expect(f(ctx('http://s/x', { sub: 'other' }))).toBe(false); // undefined → rollout (none) → off
	});

	it('record = weighted variants; anonymous → control (first key)', () => {
		const hero = flag('hero', { control: 80, bold: 20 });
		expect(hero(ctx())).toBe('control'); // anonymous, no split
		const one = ctx('http://s/x', { vid: 'v-1' });
		expect(hero(one)).toBe(hero(one));
		expect(['control', 'bold']).toContain(hero(one));
	});

	it('weights are RATIOS, not percentages (3:1 ≈ 75/25)', () => {
		const f = flag('ratio', { a: 3, b: 1 });
		let b = 0;
		for (let i = 0; i < 3000; i++) if (f(ctx('http://s/x', { vid: `v${i}` })) === 'b') b++;
		expect(b / 3000).toBeGreaterThan(0.2);
		expect(b / 3000).toBeLessThan(0.3);
	});
});

describe('flag — decision precedence', () => {
	it('?og-exp override beats everything (unknown variants ignored)', () => {
		const f = flag('o', { control: 100, v2: 0 });
		expect(f(ctx('http://s/x?og-exp=o:v2', { vid: 'v' }))).toBe('v2');
		expect(f(ctx('http://s/x?og-exp=o:hax', { vid: 'v' }))).toBe('control');
	});

	it('carried claims (upstream shell) beat the native rule', () => {
		const f = flag('c', { control: 100, v2: 0 });
		expect(f(ctx('http://s/x', { claims: { experiments: { c: 'v2' } } }))).toBe('v2');
		const k = flag('kill', 100);
		expect(k(ctx('http://s/x', { claims: { sub: 'u', experiments: { kill: 'off' } } }))).toBe(
			false
		);
	});

	it('the override GATE: closed → ?og-exp is inert (prod default); reopened → honored', () => {
		const f = flag('gated', 0);
		const url = 'http://s/x?og-exp=gated:on';
		decide({ overrides: () => false });
		expect(f(ctx(url, { vid: 'a' }))).toBe(false);
		decide({ overrides: () => true });
		expect(f(ctx(url, { vid: 'b' }))).toBe(true);
	});
});

describe('flag — layers (mutual exclusion, a string group)', () => {
	it('a visitor lands in at most ONE member', () => {
		const a = flag('hero-video', 100, { layer: 'hero' });
		const b = flag('hero-quiz', 100, { layer: 'hero' });
		let in_a = 0;
		let in_b = 0;
		for (let i = 0; i < 500; i++) {
			const c = ctx('http://s/x', { vid: `v${i}` });
			expect((a(c) ? 1 : 0) + (b(c) ? 1 : 0)).toBeLessThanOrEqual(1);
			if (a(c)) in_a++;
			if (b(c)) in_b++;
		}
		expect(in_a).toBeGreaterThan(150);
		expect(in_b).toBeGreaterThan(150);
	});
});

describe('flag.pick — one verb, two forms', () => {
	it('one-arg form = a page slot (ComponentPick), resolved per request, control fallback', () => {
		const A = { n: 'A' };
		const B = { n: 'B' };
		const hero = flag('hero', { control: 50, bold: 50 });
		const p = hero.pick({ control: A, bold: B });
		expect(p.__ogpick(ctx('http://s/x?og-exp=hero:bold'))).toBe(B);
		expect(p.__ogpick(ctx('http://s/x?og-exp=hero:control'))).toBe(A);
		expect(p.__ogpick(ctx())).toBe(A); // anonymous → control
	});

	it('two-arg form = pick this visitor a value (numbers, strings, config)', () => {
		const trial = flag('trial', { control: 50, generous: 50 });
		expect(trial.pick(ctx('http://s/x?og-exp=trial:generous'), { control: 7, generous: 30 })).toBe(
			30
		);
		expect(trial.pick(ctx('http://s/x?og-exp=trial:control'), { control: 7, generous: 30 })).toBe(
			7
		);
		const label = flag('cta', { control: 50, bold: 50 });
		expect(label.pick(ctx(), { control: 'Buy', bold: 'BUY' })).toBe('Buy'); // anonymous → control
	});

	it('boolean flag pick maps off/on', () => {
		const kill = flag('kill', 100);
		expect(kill.pick(ctx('http://s/x', { vid: 'v' }), { off: 'a', on: 'b' })).toBe('b');
	});

	it('stamp names the world for analytics', () => {
		const hero = flag('hero', { control: 50, bold: 50 });
		expect(hero.stamp(ctx('http://s/x?og-exp=hero:bold'))).toBe('hero:bold');
	});
});

// A trivial Standard Schema for `value` tests: accepts { text: string }, rejects everything else.
const BannerSchema: StandardSchemaV1<{ text: string }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: (v: unknown) =>
			v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string'
				? { value: v as { text: string } }
				: { issues: [{ message: 'bad banner' }] }
	}
};

describe('decide + source — the OpenFeature seam (any resolver)', () => {
	it('source decides a variant; validated against declared variants; primes once per request', async () => {
		const calls: string[] = [];
		const source: FlagSource = (queries, c) => {
			calls.push(c.request.url);
			const out: Record<string, string> = {};
			for (const q of queries) if (q.name === 'hero') out.hero = 'bold';
			return out;
		};
		decide({ source });
		const hero = flag('hero', { control: 100, bold: 0 }); // native says control; source overrides
		const c = ctx('http://s/x', { vid: 'v1' });
		await prime_flags(c);
		expect(hero(c)).toBe('bold');
		await prime_flags(c); // idempotent — no second source call
		expect(calls).toHaveLength(1);
	});

	it('a source variant NOT in the declared set is ignored (falls through to native)', async () => {
		decide({ source: () => ({ f: 'nonsense' }) });
		const f = flag('f', { control: 100, v2: 0 });
		const c = ctx('http://s/x', { vid: 'v1' });
		await prime_flags(c);
		expect(f(c)).toBe('control');
	});

	it('override still beats the source', async () => {
		decide({ source: () => ({ g: 'off' }) });
		const g = flag('g');
		const c = ctx('http://s/x?og-exp=g:on', { vid: 'v1' });
		await prime_flags(c);
		expect(g(c)).toBe(true);
	});

	it('a throwing source degrades every flag to native, never the request', async () => {
		decide({
			source: () => {
				throw new Error('vendor down');
			}
		});
		const f = flag('h', 100);
		const c = ctx('http://s/x', { vid: 'v1' });
		await expect(prime_flags(c)).resolves.toBeUndefined();
		expect(f(c)).toBe(true); // native rollout still works
	});

	it('bare boolean/string source values are sugar for { variant }', async () => {
		decide({ source: () => ({ a: true, b: 'bold' }) });
		const a = flag('a');
		const b = flag('b', { control: 0, bold: 100 });
		const c = ctx('http://s/x', { vid: 'v1' });
		await prime_flags(c);
		expect(a(c)).toBe(true);
		expect(b(c)).toBe('bold');
	});
});

describe('flag.value — vendor payloads, schema-validated', () => {
	it('returns the validated payload, else the fallback', async () => {
		decide({ source: () => ({ banner: { variant: 'on', value: { text: 'hi' } } }) });
		const banner = flag('banner', 100, { value: BannerSchema, fallback: { text: '' } });
		const c = ctx('http://s/x', { vid: 'v1' });
		await prime_flags(c);
		expect(banner.value(c)).toEqual({ text: 'hi' });
	});

	it('an invalid vendor payload is rejected → fallback (trust boundary)', async () => {
		decide({ source: () => ({ banner: { variant: 'on', value: { text: 42 } } }) });
		const banner = flag('banner', 100, { value: BannerSchema, fallback: { text: 'safe' } });
		const c = ctx('http://s/x', { vid: 'v1' });
		await prime_flags(c);
		expect(banner.value(c)).toEqual({ text: 'safe' });
	});

	it('no source → fallback, never undefined', () => {
		const banner = flag('banner2', 0, { value: BannerSchema, fallback: { text: 'default' } });
		expect(banner.value(ctx())).toEqual({ text: 'default' });
	});
});

describe('decide — exposure batching', () => {
	it('fires once per (request, flag); flushes at max, at the timer, and at flush_exposures()', () => {
		vi.useFakeTimers();
		const batches: Array<Array<{ name: string; variant: string }>> = [];
		decide({
			exposure: (b) => {
				batches.push(b as Array<{ name: string; variant: string }>);
				throw new Error('pipeline down'); // contained
			},
			batch: { max: 2, ms: 1000 }
		});
		try {
			const f = flag('batched', 100);
			const c1 = ctx('http://s/x', { sub: 'v1', vid: 'v1' });
			expect(f(c1)).toBe(true);
			f(c1); // memo hit — no second exposure
			expect(batches).toHaveLength(0); // below max
			f(ctx('http://s/x', { sub: 'v2', vid: 'v2' })); // hits max=2
			expect(batches).toHaveLength(1);
			expect(batches[0].map((e) => e.name)).toEqual(['batched', 'batched']);
			f(ctx('http://s/x', { sub: 'v3', vid: 'v3' }));
			flush_exposures(); // manual drain (the per-request tail)
			expect(batches).toHaveLength(2);
			expect(batches[1]).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('federation — decided flags auto-carry', () => {
	it('every flag decided this request self-registers its bucket for signed claims', () => {
		const hero = flag('hero', { control: 0, bold: 100 });
		const kill = flag('kill', 100);
		const c = ctx('http://s/x', { vid: 'v1' });
		hero(c);
		kill(c);
		expect(assigned_buckets(c.request)).toEqual({ hero: 'bold', kill: 'on' });
	});

	it('a flag never read this request does NOT carry', () => {
		flag('unread', 100);
		const c = ctx('http://s/x', { vid: 'v1' });
		expect(assigned_buckets(c.request)).toBeUndefined();
	});
});
