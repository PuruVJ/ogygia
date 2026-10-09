import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tool_fetch, tool_made } from '../src/tool-fetches.js';

const entry = (name: string, startTime: number, initiatorType = 'fetch') => ({ name, startTime, initiatorType }) as PerformanceResourceTiming;

describe("the tools' own requests", () => {
	const real = { fetch: globalThis.fetch, location: (globalThis as { location?: unknown }).location, now: globalThis.performance.now };
	let now = 0;
	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[Symbol.for('ogygia.tool-fetches')];
		(globalThis as { location?: unknown }).location = { href: 'http://x.test/hell' };
		globalThis.fetch = (async () => new Response('')) as typeof fetch;
		now = 0;
		globalThis.performance.now = () => now;
	});
	afterEach(() => {
		globalThis.fetch = real.fetch;
		globalThis.performance.now = real.now;
		(globalThis as { location?: unknown }).location = real.location;
	});

	it("a chunk the devtools read is theirs; the page's load of the same file is not", async () => {
		now = 5000;
		await tool_fetch('./_app/immutable/chunks/a.js', { cache: 'force-cache' });
		expect(tool_made(entry('http://x.test/_app/immutable/chunks/a.js', 5000.4))).toBe(true);
		// the page's module load: a script, before or after
		expect(tool_made(entry('http://x.test/_app/immutable/chunks/a.js', 120, 'script'))).toBe(false);
		expect(tool_made(entry('http://x.test/_app/immutable/chunks/a.js', 5001, 'other'))).toBe(false);
		// the page's own fetch of it, long before the devtools asked
		expect(tool_made(entry('http://x.test/_app/immutable/chunks/a.js', 300))).toBe(false);
		// another file
		expect(tool_made(entry('http://x.test/_app/immutable/chunks/b.js', 5000.4))).toBe(false);
	});

	it('each request is noted: a second probe of the same file is theirs too', async () => {
		now = 100;
		await tool_fetch('http://x.test/x.css', { method: 'HEAD' });
		now = 9000;
		await tool_fetch('http://x.test/x.css', { method: 'HEAD' });
		expect(tool_made(entry('http://x.test/x.css', 9000.2))).toBe(true);
		expect(tool_made(entry('http://x.test/x.css', 4000))).toBe(false);
	});

	it('nothing noted: nothing is theirs', () => {
		expect(tool_made(entry('http://x.test/a.js', 1))).toBe(false);
	});
});
