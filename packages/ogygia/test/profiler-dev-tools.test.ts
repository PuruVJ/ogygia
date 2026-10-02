// On the dev server, the dev server's own work is left out of what the report blames
// (profiler/report.ts `dev_tool_caller`): a sampled origin in a dev tool's package — never the app's
// line, never a runtime library the build keeps.
import { expect, test } from 'vitest';
import { dev_tool_caller, mostly_waited } from '../src/profiler/report.js';

test('mostly waiting is read off one render, not the window the profiler idled in', () => {
	// a page rendering in 0.4 ms: the window was idle between renders, the render waited on nothing
	expect(mostly_waited({ window_ms: 0.4, wait_ms: 0, gap_ms: 0.1 }, 3)).toBe(false);
	// a render of 400 ms that waited 300 of it on calls
	expect(mostly_waited({ window_ms: 400, wait_ms: 300, gap_ms: 10 }, 40)).toBe(true);
	// a render that computed most of its 200 ms
	expect(mostly_waited({ window_ms: 200, wait_ms: 40, gap_ms: 10 }, 5)).toBe(false);
	// no timeline: the window's CPU, as before
	expect(mostly_waited(null, 10)).toBe(true);
});

test('a dev tool’s origin, by its package', () => {
	expect(dev_tool_caller('_read (vite)')).toBe(true);
	expect(dev_tool_caller('resolveId (rolldown)')).toBe(true);
	expect(dev_tool_caller('transform (@sveltejs/vite-plugin-svelte)')).toBe(true);
	expect(dev_tool_caller('x (@rolldown/binding-darwin-arm64)')).toBe(true);
});

test('the app’s lines and the libraries a build keeps are not', () => {
	expect(dev_tool_caller('drainJobs (routes/inferno/+page.server.ts:54)')).toBe(false);
	expect(dev_tool_caller('#collect_content_async (svelte)')).toBe(false);
	expect(dev_tool_caller('(no frame outside node)')).toBe(false);
	expect(dev_tool_caller('hydrateApp (@acme/ui)')).toBe(false);
});
