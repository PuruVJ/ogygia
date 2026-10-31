import { describe, it, expect } from 'vitest';
import { pick_fields } from '../src/profiler/index.ts';

describe('pick_fields (a compact profile)', () => {
	const report = {
		schema: 's',
		version: 1,
		engine: { version: 3 },
		id: 'x',
		target: {},
		links: {},
		findings: [1],
		stacks: 'big',
		hot_functions: 'big',
		summary: { busy_ms: 1 }
	};
	it('only the sections asked for, and what names the report', () => {
		expect(pick_fields(report, 'findings, summary')).toEqual({
			schema: 's',
			version: 1,
			engine: { version: 3 },
			id: 'x',
			target: {},
			links: {},
			findings: [1],
			summary: { busy_ms: 1 }
		});
	});
	it('whole when nothing is asked', () => {
		expect(pick_fields(report, null)).toBe(report);
	});
});
