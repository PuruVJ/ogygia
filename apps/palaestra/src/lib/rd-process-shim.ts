/**
 * `@rolldown/browser`'s utils bundle reads `process.versions` at module-load (it ships the tsconfig /
 * transform helpers next to the parser). In a Web Worker there is no `process`, so it throws. This
 * provides a MINIMAL browser `process` — imported FIRST in the worker (ES modules evaluate imports in
 * source order), so it exists before rolldown-browser loads. Worker-scoped: no global Vite `define`,
 * so the SSR build's real `process` is never touched.
 */
const g = globalThis as unknown as { process?: unknown };
if (typeof g.process === 'undefined') {
	g.process = {
		versions: {},
		env: {},
		platform: 'browser',
		argv: [] as string[],
		cwd: () => '/'
	};
}

export {};
