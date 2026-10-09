import { describe, expect, it } from 'vitest';
import { build_module_map } from '../src/vite/module-map.js';
import { module_category } from '../src/profiler/module-map.js';

// A build without sourcemaps leaves only chunk names: the module map says which source module is
// at which lines of each server chunk, so a frame is filed by what it is.

describe('build_module_map', () => {
	it('each module at its lines of the chunk, ids relative to the root, queries dropped', () => {
		const a = 'function a() {\n\treturn 1;\n}\n';
		const b = 'export function b() {}\n';
		const code = `import x from './x.js';\n${a}\n${b}export { a };\n`;
		const map = build_module_map(
			{
				'chunks/lib.js': {
					type: 'chunk',
					fileName: 'chunks/lib.js',
					code,
					modules: {
						'/root/src/lib/a.ts': { code: a },
						'/root/node_modules/dslib/b.js?v=1': { code: b },
						'/root/src/empty.ts': { code: '' }
					}
				},
				'app.css': { type: 'asset', fileName: 'app.css' }
			},
			'/root'
		);
		expect(map).toEqual({
			v: 1,
			chunks: {
				'chunks/lib.js': [
					// a: lines 2–4 (its trailing newline ends line 4); line 5 is blank; b: line 6
					[2, 4, 'src/lib/a.ts'],
					[6, 6, 'node_modules/dslib/b.js']
				]
			}
		});
	});
});

describe('build_module_map: a module starting with a newline', () => {
	it('the modules after it keep their lines', () => {
		const a = '\nconst a = 1;\n';
		const b = 'const b = 2;\nconst c = 3;\n';
		const code = `// head\n${a}${b}`;
		const map = build_module_map(
			{
				'x.js': {
					type: 'chunk',
					fileName: 'x.js',
					code,
					modules: { '/r/a.ts': { code: a }, '/r/b.ts': { code: b } }
				}
			},
			'/r'
		);
		// head on 1; a's blank line 2 and its code 3; b on 4–5
		expect(map.chunks['x.js']).toEqual([
			[2, 3, 'a.ts'],
			[4, 5, 'b.ts']
		]);
	});
});

describe('build_module_map: a module whose imports the bundler dropped', () => {
	it('is found by its first solid line, and the modules after it keep their lines', () => {
		// the modules' own code opens with imports; the chunk has them hoisted away
		const a =
			"import { x } from './x.js';\nimport { y } from './y.js';\nexport function respond(event) {\n\treturn render_page(event, options);\n}\n";
		const b =
			"import { z } from './z.js';\nexport function render_page(event, options) {\n\treturn new Response('ok');\n}\n";
		const code =
			"import { x, y, z } from './shared.js';\nexport function respond(event) {\n\treturn render_page(event, options);\n}\nexport function render_page(event, options) {\n\treturn new Response('ok');\n}\n";
		const map = build_module_map(
			{
				'index.js': {
					type: 'chunk',
					fileName: 'index.js',
					code,
					modules: {
						'/r/node_modules/@sveltejs/kit/respond.js': { code: a },
						'/r/node_modules/@sveltejs/kit/page.js': { code: b }
					}
				}
			},
			'/r'
		);
		expect(map.chunks['index.js']).toEqual([
			[2, 4, 'node_modules/@sveltejs/kit/respond.js'],
			[5, 7, 'node_modules/@sveltejs/kit/page.js']
		]);
	});
});

describe("build_module_map: the bundler's own region markers", () => {
	it('each //#region … //#endregion is a module at exactly those lines', () => {
		const code = [
			"import { x } from './shared.js';",
			'//#region ../../node_modules/.pnpm/@sveltejs+kit@2/node_modules/@sveltejs/kit/src/runtime/server/respond.js',
			'function respond() {',
			'\treturn 1;',
			'}',
			'//#endregion',
			'//#region src/lib/Card.svelte',
			'function Card($$renderer) {}',
			'//#endregion',
			'export { respond, Card };'
		].join('\n');
		const map = build_module_map(
			{
				'index.js': {
					type: 'chunk',
					fileName: 'index.js',
					code,
					modules: { '/r/whatever.js': { code: 'x' } }
				}
			},
			'/r'
		);
		expect(map.chunks['index.js']).toEqual([
			[3, 5, 'node_modules/@sveltejs/kit/src/runtime/server/respond.js'],
			[8, 8, 'src/lib/Card.svelte']
		]);
	});
});

describe("build_module_map: the app's own folding comments inside a module", () => {
	it('a //#region that names no module is not a module, and does not end the real one early', () => {
		const code = [
			'//#region src/lib/a.ts',
			'//#region Helpers',
			'function h() {}',
			'//#endregion',
			'function a() {}',
			'//#endregion'
		].join('\n');
		const map = build_module_map(
			{
				'x.js': {
					type: 'chunk',
					fileName: 'x.js',
					code,
					modules: { '/r/src/lib/a.ts': { code: 'x' } }
				}
			},
			'/r'
		);
		expect(map.chunks['x.js']).toEqual([[2, 5, 'src/lib/a.ts']]);
	});
});

describe('module_category', () => {
	it('the profiler, ogygia, a package, or (undefined) the app', () => {
		expect(module_category('../../packages/ogygia/src/profiler/frames.ts')).toEqual({
			category: 'profiler'
		});
		expect(module_category('node_modules/ogygia/dist/profiler/net.js')).toEqual({
			category: 'profiler'
		});
		expect(module_category('../../packages/ogygia/src/runtime/hash.ts')).toEqual({
			category: 'dependency',
			pkg: 'ogygia'
		});
		expect(module_category('node_modules/@acme/ui/hydrate/index.mjs')).toEqual({
			category: 'dependency',
			pkg: '@acme/ui'
		});
		expect(module_category('node_modules/svelte/src/internal/server/index.js')).toEqual({
			category: 'svelte',
			pkg: 'svelte'
		});
		expect(module_category('src/lib/inferno/format.ts')).toBeUndefined();
		// ogygia's generated island wrappers and virtual entries are its code, not the app's
		expect(module_category('virtual:ogygia/wrapper/4b95bfb97fab.svelte')).toEqual({
			category: 'dependency',
			pkg: 'ogygia'
		});
		expect(module_category('\\0virtual:ogygia/server-manifest')).toEqual({
			category: 'dependency',
			pkg: 'ogygia'
		});
	});
});
