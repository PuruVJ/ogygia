// Kit's `render_response` hashes the whole HTML for the page's ETag. A build bundles Kit's `hash`
// into a shared chunk (`chunks/exports-….js`) with no package in its path: without a map it read
// as the app's code — a 148 ms "app code" function on a customer's large page. Called straight
// from `render_response`, it is Kit's.
import { describe, expect, it } from 'vitest';
import { analyze, type CpuProfile } from '../src/profiler/analyze.js';

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });

function profile(parent: string): CpuProfile {
	return {
		startTime: 0,
		endTime: 20_000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2] },
			{ id: 2, callFrame: frame(parent, 'file:///var/task/server/index.js', 1700), children: [3] },
			{ id: 3, callFrame: frame('hash', 'file:///var/task/server/chunks/exports-1yKZVnuP.js', 64), positionTicks: [{ line: 68, ticks: 4 }] }
		],
		samples: [3, 3, 3, 3],
		timeDeltas: [5000, 5000, 5000, 5000]
	};
}

describe("Kit's ETag hash in a bundled chunk", () => {
	it('under render_response: Kit’s, not the app’s', () => {
		const fn = analyze(profile('render_response')).functions.find((f) => f.name === 'hash')!;
		expect(fn.pkg).toBe('@sveltejs/kit');
		expect(fn.category).toBe('dependency');
	});

	it('an app’s own `hash` (any other caller) stays the app’s', () => {
		const fn = analyze(profile('load')).functions.find((f) => f.name === 'hash')!;
		expect(fn.pkg).toBeUndefined();
		expect(fn.category).toBe('app');
	});
});
