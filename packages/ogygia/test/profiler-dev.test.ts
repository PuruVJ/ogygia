import { describe, expect, it } from 'vitest';
import { categorize, learn_script_urls, sourcemap_resolver, with_script_url } from '../src/profiler/analyze.js';
import { file_of } from '../src/profiler/frames.js';

// THE PROFILER ON THE DEV SERVER: Vite runs each server module as transformed code made from a string
// (`new AsyncFunction(code)` with a `//# sourceURL`), and pre-bundles dependencies into `.vite/`.

describe('the dev server', () => {
	it("a pre-bundled dependency is its package: Svelte's own runtime is Svelte, not `.vite`", () => {
		const f = (url: string) => categorize({ functionName: 'component', url, lineNumber: 0, columnNumber: 0 });
		expect(f('file:///app/node_modules/.vite/deps_ssr/svelte_internal_server.js')).toEqual({ category: 'svelte', pkg: 'svelte' });
		expect(f('file:///app/node_modules/.vite/deps_ssr/@acme_ui_components.js?v=1a2b')).toMatchObject({ category: 'dependency', pkg: '@acme/ui' });
	});

	it('a heap sample of a module made from a string has no url: its script id names it', () => {
		learn_script_urls({ nodes: [{ id: 1, callFrame: { functionName: 'remember', scriptId: '901', url: 'file:///app/src/lib/remember.ts', lineNumber: 3, columnNumber: 0 } }] });
		expect(with_script_url({ functionName: 'remember', scriptId: '901', url: '', lineNumber: 3, columnNumber: 0 }).url).toBe('file:///app/src/lib/remember.ts');
		// a frame with its own url, or an unknown id: as it is
		expect(with_script_url({ functionName: 'x', scriptId: '902', url: '', lineNumber: 0, columnNumber: 0 }).url).toBe('');
	});

	it("a `.ts` module's map comes from the dev server (any extension), shifted by the runner's own lines", () => {
		// the transformed code's line 0 maps to source line 4 (0-based 3); the runner puts 3 lines before it
		const map = JSON.stringify({ version: 3, sources: ['load.ts'], mappings: ';;;AAGA' });
		const read = (p: string) => (p === '/app/src/load.ts.map' ? map : undefined);
		expect(sourcemap_resolver(read).resolve('/app/src/load.ts', 3, 0)).toBeUndefined();
		expect(sourcemap_resolver(read, undefined, { any_ext: true }).resolve('/app/src/load.ts', 3, 0)).toMatchObject({
			source: '/app/src/load.ts',
			line: 4
		});
	});

	it("a call site's file: its sourceURL when it has no file name (code made from a string)", () => {
		const site = { getFileName: () => undefined, getScriptNameOrSourceURL: () => '/app/src/x.ts' } as unknown as NodeJS.CallSite;
		expect(file_of(site)).toBe('/app/src/x.ts');
		const real = { getFileName: () => '/app/a.js', getScriptNameOrSourceURL: () => 'other' } as unknown as NodeJS.CallSite;
		expect(file_of(real)).toBe('/app/a.js');
		// and a real one read through `new Function` in this very process
		const make = new Function('return (() => { const E = Error; let s; const o = E.prepareStackTrace; E.prepareStackTrace = (_, x) => x; const h = {}; E.captureStackTrace(h); s = h.stack; E.prepareStackTrace = o; return s; })();\n//# sourceURL=/app/src/made.ts') as () => NodeJS.CallSite[];
		expect(file_of(make()[0])).toBe('/app/src/made.ts');
	});
});
