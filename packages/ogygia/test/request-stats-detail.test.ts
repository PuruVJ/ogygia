/**
 * DETAIL IS COUNTED (server/request-stats.ts): two profilers can record at once in one process (the
 * dev server re-runs the app's hooks on an edit: a new profiler, while the old one's timers still
 * record). The first window to end must not turn detail off under the other.
 */
import { describe, it, expect } from 'vitest';
import { request_stats_detailed, set_request_stats_detail } from '../src/server/request-stats.js';

describe('set_request_stats_detail', () => {
	it('stays on while any window records; overlapping windows end in any order', () => {
		expect(request_stats_detailed()).toBe(false);
		set_request_stats_detail(true); // window A
		set_request_stats_detail(true); // window B, overlapping
		set_request_stats_detail(false); // A ends first
		expect(request_stats_detailed()).toBe(true); // B still records: its render keeps its rows
		set_request_stats_detail(false); // B ends
		expect(request_stats_detailed()).toBe(false);
	});
	it('an extra off never goes below none (the next window still turns it on)', () => {
		set_request_stats_detail(false);
		set_request_stats_detail(false);
		expect(request_stats_detailed()).toBe(false);
		set_request_stats_detail(true);
		expect(request_stats_detailed()).toBe(true);
		set_request_stats_detail(false);
		expect(request_stats_detailed()).toBe(false);
	});
});
