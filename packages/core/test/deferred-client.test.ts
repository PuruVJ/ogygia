/**
 * Deferred client island contracts that sit between transform attrs and the runtime
 * `#server` → phase-2 `#hydrate` path (DESIGN.md). Pure helpers only — browser swap/hydrate
 * is covered by `verify/defer-hydrate.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
	is_awake,
	is_deferred,
	phase2_hydrate_schedule,
	region_hydrate_schedule,
	region_schedule
} from '../src/runtime/region-attrs.ts';

/** Minimal Element-like (no DOM env). The helpers read only `getAttribute`, so that subset is
 *  handed to their `Element` signatures. */
function fake_el(attrs: Record<string, string> = {}): Element {
	const el: Pick<Element, 'getAttribute'> = {
		getAttribute: (name) =>
			Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null
	};
	return el as Element;
}

/** Mirror of ServerIsland `wants_modulepreload` (no second idle/IO when phase-2 is load). */
function wants_modulepreload(defer: string, hydrate: string) {
	return hydrate === 'load' || hydrate === defer;
}

describe('deferred client island runtime contracts', () => {
	it('after swap: matching schedules → phase2 load (immediate hydrate, modulepreload eligible)', () => {
		const cases: Array<[string, string]> = [
			['load', 'load'],
			['idle', 'idle'],
			['visible', 'visible'],
			['(min-width: 700px)', '(min-width: 700px)']
		];
		for (const [defer, hydrate] of cases) {
			expect(phase2_hydrate_schedule(defer, hydrate)).toBe('load');
			expect(wants_modulepreload(defer, hydrate)).toBe(true);
		}
	});

	it('after swap: hydrate:load after any defer → ASAP (modulepreload)', () => {
		for (const defer of ['idle', 'visible', '(max-width: 600px)']) {
			expect(phase2_hydrate_schedule(defer, 'load')).toBe('load');
			expect(wants_modulepreload(defer, 'load')).toBe(true);
		}
	});

	it('after swap: defer:load + hydrate:visible|idle arms a SECOND schedule (no modulepreload)', () => {
		expect(phase2_hydrate_schedule('load', 'visible')).toBe('visible');
		expect(phase2_hydrate_schedule('load', 'idle')).toBe('idle');
		expect(wants_modulepreload('load', 'visible')).toBe(false);
		expect(wants_modulepreload('load', 'idle')).toBe(false);
	});

	it('DOM attrs: phase-1 uses when; phase-2 reads hydrate (awake deferred region)', () => {
		const el = fake_el({
			render: 'defer',
			when: 'idle',
			wake: 'visible',
			'hydrate-margin': '200px',
			entry: '/_app/immutable/og-region.abc123.js',
			endpoint: '/__ogygia__?id=x'
		});
		expect(is_deferred(el)).toBe(true);
		expect(is_awake(el)).toBe(true);
		expect(region_schedule(el)).toBe('idle');
		expect(region_hydrate_schedule(el)).toBe('visible');
		expect(phase2_hydrate_schedule(region_schedule(el), region_hydrate_schedule(el)!)).toBe(
			'visible'
		);
	});

	it('defer-only hole: no phase-2 hydrate schedule', () => {
		const el = fake_el({ render: 'defer', when: 'load' });
		expect(is_deferred(el)).toBe(true);
		expect(is_awake(el)).toBe(false);
		expect(region_hydrate_schedule(el)).toBe(null);
	});
});
