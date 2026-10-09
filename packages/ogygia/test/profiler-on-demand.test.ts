/**
 * Demand-only profiler routing (`profiler: { onDemand: true }`). The handle uses this to decide, per
 * request, whether to touch the profiler AT ALL before importing it — so on a serverless host a cold
 * start pays the profiler's import only once someone actually opens the dashboard, not on every first
 * request. `skip === true` means "go straight to the core handle; do not import/parse/init the profiler".
 */
import { describe, it, expect } from 'vitest';
import { profiler_demand_skip } from '../src/profiler/on-demand.js';

const P = '/__profiler';

describe('profiler_demand_skip', () => {
	it('demand-only + not mounted + a normal page request → SKIP (profiler never imported)', () => {
		expect(profiler_demand_skip(true, false, '/id/en/about-us/', P)).toBe(true);
		expect(profiler_demand_skip(true, false, '/', P)).toBe(true);
	});

	it('demand-only + not mounted + a request TO the profiler path → do NOT skip (mount it now)', () => {
		expect(profiler_demand_skip(true, false, '/__profiler', P)).toBe(false);
		expect(profiler_demand_skip(true, false, '/__profiler/reports.json', P)).toBe(false);
		// base-prefixed deploy: the reserved segment still appears → matched
		expect(profiler_demand_skip(true, false, '/app/__profiler', P)).toBe(false);
	});

	it('once mounted, never skip again — later requests are instrumented like normal mode', () => {
		expect(profiler_demand_skip(true, true, '/id/en/about-us/', P)).toBe(false);
	});

	it('not demand-only (default) → never skip, profiler behaves as today', () => {
		expect(profiler_demand_skip(false, false, '/id/en/about-us/', P)).toBe(false);
		expect(profiler_demand_skip(false, false, '/__profiler', P)).toBe(false);
	});

	it('honours a custom profiler path', () => {
		expect(profiler_demand_skip(true, false, '/_perf', '/_perf')).toBe(false);
		expect(profiler_demand_skip(true, false, '/__profiler', '/_perf')).toBe(true);
	});
});
