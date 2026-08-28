// `experiment()` — the assignment primitive. Splits/flags/targeting/rollouts are one thing:
// variants assigned per visitor, deterministically. These tests pin the precedence chain
// (override → carried → assign → split → control), stickiness, split accuracy, layer
// exclusivity, and the page() ComponentPick contract.
import { describe, it, expect, beforeAll } from 'vitest';
import { experiment, flag, layer, allowOverrides } from '../src/experiment.js';

const CLAIMS = Symbol.for('ogygia.claims.v1');

// overrides are DEV-gated (prod default: closed) — open them explicitly so these tests don't
// depend on how the test runner resolves esm-env's DEV condition
beforeAll(() => allowOverrides(() => true));

function ctx(
	url = 'http://s/x',
	opts: { vid?: string; claims?: Record<string, unknown> } = {}
) {
	const request = new Request(url);
	if (opts.claims) (request as unknown as Record<symbol, unknown>)[CLAIMS] = opts.claims;
	return {
		request,
		url: new URL(url),
		cookies: { get: (n: string) => (n === 'og-vid' ? opts.vid : undefined) }
	};
}

describe('experiment — precedence and stickiness', () => {
	it('anonymous (no visitor identity) → control, never a split', () => {
		const e = experiment('a', { variants: ['control', 'v2'], split: { v2: 100 } });
		expect(e.bucket(ctx())).toBe('control');
	});

	it('split is sticky per visitor and ~accurate over a population', () => {
		const e = experiment('roll', { variants: ['control', 'v2'], split: { v2: 10 } });
		const one = ctx('http://s/x', { vid: 'visitor-42' });
		expect(e.bucket(one)).toBe(e.bucket(one)); // deterministic
		let hits = 0;
		for (let i = 0; i < 2000; i++) if (e.bucket(ctx('http://s/x', { vid: `v${i}` })) === 'v2') hits++;
		expect(hits / 2000).toBeGreaterThan(0.07); // 10% ± tolerance
		expect(hits / 2000).toBeLessThan(0.13);
	});

	it('?og-exp override beats everything', () => {
		const e = experiment('o', {
			variants: ['control', 'v2'],
			assign: () => 'control',
			split: {}
		});
		expect(e.bucket(ctx('http://s/x?og-exp=o:v2', { vid: 'v' }))).toBe('v2');
		// unknown variant names are ignored, not honored
		expect(e.bucket(ctx('http://s/x?og-exp=o:hax', { vid: 'v' }))).toBe('control');
	});

	it('carried assignment (upstream shell decided) beats assign and split', () => {
		const e = experiment('c', {
			variants: ['control', 'v2'],
			assign: () => 'control',
			split: {}
		});
		expect(e.bucket(ctx('http://s/x', { claims: { experiments: { c: 'v2' } } }))).toBe('v2');
	});

	it('assign() is any condition; undefined falls through to the split', () => {
		const e = experiment('beta', {
			variants: ['control', 'v2'],
			assign: (c) => (c.cookies?.get('og-vid') === 'beta-user' ? 'v2' : undefined),
			split: { v2: 0 }
		});
		expect(e.bucket(ctx('http://s/x', { vid: 'beta-user' }))).toBe('v2');
		expect(e.bucket(ctx('http://s/x', { vid: 'someone-else' }))).toBe('control');
	});
});

describe('experiment — layers (mutual exclusion)', () => {
	it('a visitor lands in at most ONE member experiment', () => {
		const hero = layer('hero-slot');
		const a = experiment('hero-video', { variants: ['control', 'on'], split: { on: 100 }, layer: hero });
		const b = experiment('hero-quiz', { variants: ['control', 'on'], split: { on: 100 }, layer: hero });
		let in_a = 0;
		let in_b = 0;
		for (let i = 0; i < 500; i++) {
			const c = ctx('http://s/x', { vid: `v${i}` });
			const both = (a.bucket(c) === 'on' ? 1 : 0) + (b.bucket(c) === 'on' ? 1 : 0);
			expect(both).toBeLessThanOrEqual(1); // NEVER both
			if (a.bucket(c) === 'on') in_a++;
			if (b.bucket(c) === 'on') in_b++;
		}
		// both experiments actually receive traffic (roughly half each at 100% internal split)
		expect(in_a).toBeGreaterThan(150);
		expect(in_b).toBeGreaterThan(150);
	});
});

describe('experiment — pick() (the page() component chooser)', () => {
	it('resolves the arm per request and falls back to control', () => {
		const A = { name: 'A' };
		const B = { name: 'B' };
		const e = experiment('csr-mode', { variants: ['static', 'hydrated'], split: { hydrated: 100 } });
		const p = e.pick({ static: A, hydrated: B });
		expect(p.__ogpick(ctx('http://s/x?og-exp=csr-mode:hydrated'))).toBe(B);
		expect(p.__ogpick(ctx('http://s/x?og-exp=csr-mode:static'))).toBe(A);
		expect(p.__ogpick(ctx())).toBe(A); // anonymous → control arm
	});

	it('stamp() names the world for analytics', () => {
		const e = experiment('csr-mode', { variants: ['static', 'hydrated'] });
		expect(e.stamp(ctx('http://s/x?og-exp=csr-mode:hydrated'))).toBe('csr-mode:hydrated');
	});
});

describe('flag — the boolean face', () => {
	it('bare flag: off for everyone (safe default)', () => {
		const f = flag('bare');
		expect(f.on(ctx())).toBe(false);
		expect(f.on(ctx('http://s/x', { vid: 'v1' }))).toBe(false);
	});

	it('enabled(c) targets: true → on, false → DEFINITIVELY off (rollout cannot re-include)', () => {
		const f = flag('beta', {
			enabled: (c) => {
				const sub = c.visitor?.sub;
				return sub === 'beta-user' ? true : sub === 'blocked' ? false : undefined;
			},
			rollout: 100 // everyone else on — must NOT resurrect the targeted off
		});
		const as = (sub: string) => ({ ...ctx('http://s/x', { vid: sub }), visitor: { sub } });
		expect(f.on(as('beta-user'))).toBe(true);
		expect(f.on(as('blocked'))).toBe(false); // explicit false wins over the 100% rollout
		expect(f.on(as('anyone-else'))).toBe(true); // undefined fell through to rollout
	});

	it('rollout is sticky and ~accurate (same machinery as split)', () => {
		const f = flag('roll', { rollout: 10 });
		const one = ctx('http://s/x', { vid: 'v-7' });
		expect(f.on(one)).toBe(f.on(one));
		let hits = 0;
		for (let i = 0; i < 2000; i++) if (f.on(ctx('http://s/x', { vid: `v${i}` }))) hits++;
		expect(hits / 2000).toBeGreaterThan(0.07);
		expect(hits / 2000).toBeLessThan(0.13);
	});

	it('?og-exp QA override flips it like any experiment', () => {
		const f = flag('kill', { rollout: 100 });
		expect(f.on(ctx('http://s/x?og-exp=kill:off', { vid: 'v1' }))).toBe(false);
		expect(f.on(ctx('http://s/x?og-exp=kill:on'))).toBe(true); // even anonymous
	});

	it('carried claims from an upstream shell decide it (one world across teams)', () => {
		const f = flag('nav', { rollout: 0 });
		expect(f.on(ctx('http://s/x', { claims: { sub: 'u', experiments: { nav: 'on' } } }))).toBe(true);
	});

	it('the override GATE: closed → ?og-exp is inert (prod default); reopened → honored', () => {
		const f = flag('gated', { rollout: 0 });
		const url = 'http://s/x?og-exp=gated:on';
		try {
			allowOverrides(() => false); // what production is, out of the box
			expect(f.on(ctx(url, { vid: 'fresh-1' }))).toBe(false); // any visitor forcing = no-op
		} finally {
			allowOverrides(() => true);
		}
		expect(f.on(ctx(url, { vid: 'fresh-2' }))).toBe(true); // QA gate open → honored
	});

	it('IS an experiment: satisfies the routes({ experiments }) shape + pick() + stamp()', () => {
		const f = flag('page-flag', { rollout: 100 });
		// the auto-carry contract: { name, bucket(c): string }
		const carried: { name: string; bucket(c: never): string } = f;
		expect(carried.name).toBe('page-flag');
		expect(f.bucket(ctx('http://s/x', { vid: 'v1' }))).toBe('on');
		expect(f.stamp(ctx('http://s/x', { vid: 'v1' }))).toBe('page-flag:on');
		const A = () => 'off-page';
		const B = () => 'on-page';
		expect(f.pick({ off: A, on: B }).__ogpick(ctx('http://s/x', { vid: 'v1' }))).toBe(B);
	});
});
