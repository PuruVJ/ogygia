// On the dev server, the dev server's own work is left out of what the report blames
// (profiler/report.ts `dev_tool_caller`): a sampled origin in a dev tool's package — never the app's
// line, never a runtime library the build keeps.
import { expect, test } from 'vitest';
import { dev_tool_caller } from '../src/profiler/report.js';

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
