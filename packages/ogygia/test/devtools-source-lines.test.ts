/**
 * THE SOURCE'S LINE FOR A SERVED LINE (devtools/source-lines.ts): the Page tab maps a sampled frame's
 * line (the served, compiled code's) to the source's through the module's inline map.
 */
import { describe, it, expect } from 'vitest';
import { lines_of_map } from '../src/devtools/source-lines.js';

describe('lines_of_map', () => {
	it('each served line → the source line of its first segment', () => {
		// line 1: [0,0,0,0] → source line 1; line 2: nothing; line 3: [0,0,+4,0] → source line 5;
		// line 4: two segments, the first decides ([2,0,+1,0] → line 6; the second, +1 more, does not)
		const lines = lines_of_map('AAAA;;AAIA;EACA,IACA');
		expect(lines[1]).toBe(1);
		expect(lines[2]).toBe(0);
		expect(lines[3]).toBe(5);
		expect(lines[4]).toBe(6);
	});
	it('only the wanted source counts (an inlined helper is not the file’s line)', () => {
		// line 1 maps to source 1 (a helper), line 2 back to source 0 at its line 3
		const lines = lines_of_map('ACAA;ADEA', 0);
		expect(lines[1]).toBe(0);
		expect(lines[2]).toBe(3);
	});
	it('empty mappings map nothing', () => {
		expect(lines_of_map('')[1]).toBe(0);
	});
});
