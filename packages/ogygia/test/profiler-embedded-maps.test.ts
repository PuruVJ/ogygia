import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fill_profiler_maps } from '../src/vite/profiler-maps.js';
import { PROFILER_MAPS_PLACEHOLDER } from '../src/compiler/ids.js';
import {
	embedded_files,
	embedded_key,
	embedded_source,
	GZ_PREFIX,
	load_embedded_maps
} from '../src/profiler/embedded-maps.js';

// a build's embedded maps: the app's own file, a workspace package's `src/` (reached by `../`), a
// dependency
vi.mock('virtual:ogygia/profiler-maps', () => ({
	default: JSON.stringify({
		v: 1,
		modules: {},
		maps: {
			'chunks/x.js': JSON.stringify({
				version: 3,
				sources: [
					'../../../../src/lib/x.ts',
					'../../../../../../packages/kit/src/hooks.ts',
					'../../../../node_modules/lib/src/index.js'
				],
				sourcesContent: ['app x', 'package hooks', 'dependency'],
				mappings: ''
			}),
			'entries/pages/_page.svelte.js': JSON.stringify({
				version: 3,
				sources: ['../../../../../src/routes/+page.svelte', '../../../../../src/hooks.ts'],
				sourcesContent: ['app page', 'app hooks'],
				mappings: ''
			})
		}
	})
}));
import { route_imports } from '../src/profiler/route-imports.js';
import { sourcemap_resolver } from '../src/profiler/analyze.js';

// The profiler's maps travel inside the code, so any adapter ships them; a map that points at another
// built file is followed one step further.

describe('fill_profiler_maps', () => {
	it("writes the module map and every chunk's map into the placeholder, and nothing else changes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-maps-'));
		fs.mkdirSync(path.join(dir, 'chunks'));
		const lib = '//#region src/lib/a.ts\nfunction a() {}\n//#endregion\n';
		fs.writeFileSync(path.join(dir, 'chunks/a.js'), lib);
		// the server output sits at <root>/out; the map names the app file, a package, and data
		fs.writeFileSync(
			path.join(dir, 'chunks/a.js.map'),
			JSON.stringify({
				version: 3,
				sources: ['../../src/lib/a.ts', '../../node_modules/p/i.js', '../../src/lib/d.json'],
				sourcesContent: ['app text', 'package text', '{"big":1}'],
				mappings: 'AAAA'
			})
		);
		fs.writeFileSync(path.join(dir, 'chunks/data.js'), 'var d = {};\n');
		fs.writeFileSync(
			path.join(dir, 'chunks/data.js.map'),
			JSON.stringify({ version: 3, sources: ['../../src/d.json'], mappings: 'AAAA' })
		);
		const maps_code = `var maps = "${PROFILER_MAPS_PLACEHOLDER}";\nexport { maps as default };\n`;
		fs.writeFileSync(path.join(dir, 'chunks/profiler-maps.js'), maps_code);
		const bundle = {
			'chunks/a.js': {
				type: 'chunk',
				fileName: 'chunks/a.js',
				code: lib,
				modules: {
					[path.join(path.dirname(dir), 'src/lib/a.ts')]: { code: 'function a() {}\n' }
				}
			},
			'chunks/data.js': { type: 'chunk', fileName: 'chunks/data.js', code: '', modules: {} },
			'chunks/profiler-maps.js': {
				type: 'chunk',
				fileName: 'chunks/profiler-maps.js',
				code: maps_code,
				modules: {}
			}
		};
		expect(fill_profiler_maps(dir, bundle, path.dirname(dir))).toBe(true);
		const out = fs.readFileSync(path.join(dir, 'chunks/profiler-maps.js'), 'utf8');
		expect(out).not.toContain(PROFILER_MAPS_PLACEHOLDER);
		// the module's value is one string: gzipped JSON, base64
		const literal: string = JSON.parse(out.slice(out.indexOf('= ') + 2, out.indexOf(';\n')));
		expect(literal.startsWith(GZ_PREFIX)).toBe(true);
		const payload = JSON.parse(
			zlib.gunzipSync(Buffer.from(literal.slice(GZ_PREFIX.length), 'base64')).toString('utf8')
		);
		expect(payload.v).toBe(1);
		expect(payload.modules['chunks/a.js']).toEqual([[2, 2, 'src/lib/a.ts']]);
		const a = JSON.parse(payload.maps['chunks/a.js']);
		expect(a.sources).toHaveLength(3);
		// only the app's own code keeps its text; a map of data alone is left out
		expect(a.sourcesContent).toEqual(['app text', null, null]);
		expect(payload.maps['chunks/data.js']).toBeUndefined();
		// the other chunk is untouched
		expect(fs.readFileSync(path.join(dir, 'chunks/a.js'), 'utf8')).toBe(lib);
	});
});

describe('embedded_key', () => {
	it("a script's path under the server output, from Kit's output or an adapter map's source", () => {
		expect(embedded_key('/var/task/apps/web/.svelte-kit/output/server/chunks/x.js')).toBe(
			'chunks/x.js'
		);
		expect(embedded_key('/app/.svelte-kit/output/server/entries/pages/_page.svelte.js')).toBe(
			'entries/pages/_page.svelte.js'
		);
		expect(embedded_key('/app/build/server/chunks/x-abc.js')).toBeUndefined();
	});
});

describe('the resolver follows a map to another built file', () => {
	it("adapter chunk → Kit's chunk → the source", () => {
		// the adapter's chunk maps its line 0 to Kit's chunk line 0; Kit's chunk maps line 0 to src line 4
		const files: Record<string, string> = {
			'/app/build/server/chunks/x.js.map': JSON.stringify({
				version: 3,
				sources: ['../../../.svelte-kit/output/server/chunks/x.js'],
				mappings: 'AAAA'
			}),
			'/app/.svelte-kit/output/server/chunks/x.js.map': JSON.stringify({
				version: 3,
				sources: ['../../../../src/lib/x.ts'],
				mappings: 'AAIA'
			})
		};
		const r = sourcemap_resolver((p) => files[p]);
		expect(r.resolve('/app/build/server/chunks/x.js', 0, 0)).toMatchObject({
			source: '/app/src/lib/x.ts',
			line: 5
		});
	});
});

describe('embedded_source', () => {
	it("only the app's own src/ files: a package's src/ and a dependency are not filed under the app", async () => {
		expect(await load_embedded_maps()).not.toBeNull();
		expect(embedded_files().sort()).toEqual(['hooks.ts', 'lib/x.ts', 'routes/+page.svelte']);
		// the package's `src/hooks.ts` did not take the app's name
		expect(embedded_source('src/hooks.ts')).toBe('app hooks');
		expect(embedded_source('lib/x.ts')).toBe('app x');
		// an absolute path counts only under an app root a chunk path named
		embedded_key('/deploy/.svelte-kit/output/server/chunks/x.js');
		expect(embedded_source('/deploy/src/lib/x.ts')).toBe('app x');
		expect(embedded_source('/elsewhere/packages/kit/src/hooks.ts')).toBeUndefined();
		expect(embedded_source('/deploy/node_modules/lib/src/index.js')).toBeUndefined();
	});
});

describe('a chunk with no map', () => {
	it("the module map's script module at the line, its lines found by their text", () => {
		const files: Record<string, string> = {
			'/app/.svelte-kit/output/server/chunks/a.js': [
				"import { x } from './b.js';", // 1
				'//#region src/lib/load.ts', // 2
				'async function load() {', // 3
				'\tconst a = await get("a");', // 4
				'\tconst b = await get("b");', // 5
				'\treturn { a, b };', // 6
				'}', // 7
				'//#endregion' // 8
			].join('\n'),
			'/app/src/lib/load.ts': [
				"import { get } from './get';", // 1
				'', // 2
				'export async function load(): Promise<Data> {', // 3: changed by the build
				"\tconst a = await get('a');", // 4
				"\tconst b = await get('b');", // 5
				'\treturn { a, b };', // 6
				'}' // 7
			].join('\n')
		};
		const r = sourcemap_resolver(
			(p) => files[p],
			(chunk, line) =>
				chunk.endsWith('chunks/a.js') && line >= 3 && line <= 7
					? { source: '/app/src/lib/load.ts', text: true }
					: chunk.endsWith('chunks/a.js') && line === 1
						? { source: '/app/node_modules/kit/src/runtime/fetch.js', text: false }
						: undefined
		);
		const at = (l: number) => r.resolve('/app/.svelte-kit/output/server/chunks/a.js', l - 1, 0);
		expect(at(4)).toMatchObject({ source: '/app/src/lib/load.ts', line: 4, text: true });
		expect(at(5)?.line).toBe(5);
		// the function's own line lost its types: found by the name it declares
		expect(at(3)?.line).toBe(3);
		// a line the build changed: from the nearest matched line above it
		expect(r.text_nearby('/app/.svelte-kit/output/server/chunks/a.js', 6, 2)).toBe(7);
		// a package's module at the line: named by its path, with no line
		expect(at(1)).toEqual({ source: '/app/node_modules/kit/src/runtime/fetch.js', line: 0, column: 0 });
		expect(at(2)).toBeUndefined();
		// no hook: as before, the chunk's own line
		expect(sourcemap_resolver((p) => files[p]).resolve('/app/.svelte-kit/output/server/chunks/a.js', 3, 0)).toBeUndefined();
	});
});

describe('a chunk with no map: what a build does to lines', () => {
	it('types stripped, two lines folded into one, one line wrapped over five', () => {
		const chunk = '/app/.svelte-kit/output/server/entries/pages/p/_page.server.ts.js';
		const files: Record<string, string> = {
			[chunk]: [
				'//#region src/routes/p/+page.server.ts', // 1
				'var prerender = false;', // 2
				'async function get(origin, name, ms) {', // 3
				'\treturn (await fetch(`${origin}/api/${name}?ms=${ms}`)).json();', // 4
				'}', // 5
				'var load = async ({ url, fetch }) => {', // 6
				'\tconst [nav, crumbs, recs] = await Promise.all([', // 7
				'\t\tget(url.origin, "nav", 10),', // 8
				'\t\tget(url.origin, "recs-slow", 80)', // 9
				'\t]);', // 10
				'\treturn {', // 11
				'\t\tnav,', // 12
				'\t\trecs', // 13
				'\t};', // 14
				'};', // 15
				'//#endregion' // 16
			].join('\n'),
			'/app/src/routes/p/+page.server.ts': [
				"import type { PageServerLoad } from './$types';", // 1
				'export const prerender = false;', // 2
				'async function get(origin: string, name: string, ms: number): Promise<{ name: string }> {', // 3
				'\tconst res = await fetch(`${origin}/api/${name}?ms=${ms}`);', // 4
				'\treturn res.json();', // 5
				'}', // 6
				'export const load: PageServerLoad = async ({ url, fetch }) => {', // 7
				"\tconst [nav, crumbs, recs] = await Promise.all([get(url.origin, 'nav', 10), get(url.origin, 'recs-slow', 80)]); // one line", // 8
				'\treturn { nav, recs };', // 9
				'};' // 10
			].join('\n')
		};
		const r = sourcemap_resolver(
			(p) => files[p],
			() => ({ source: '/app/src/routes/p/+page.server.ts', text: true })
		);
		const at = (l: number) => r.resolve(chunk, l - 1, 0)?.line;
		expect([2, 3, 4, 6, 7, 8, 9, 10, 11, 13].map(at)).toEqual([2, 3, 4, 7, 8, 8, 8, 8, 9, 9]);
	});
});

describe('route_imports', () => {
	it('an import spread over lines', () => {
		const files: Record<string, string> = {
			'routes/a/+page.svelte':
				"<script>\n\timport Ticker from\n\t\t'$lib/a/Ticker.svelte';\n\timport {\n\t\tx\n\t} from '$lib/b/Other.svelte';\n</script>\n<p>see $lib/c/Ticker.svelte'</p>"
		};
		expect([...route_imports(Object.keys(files), (f) => files[f], 'Ticker')]).toEqual([
			'lib/a/Ticker.svelte'
		]);
		expect([...route_imports(Object.keys(files), (f) => files[f], 'Other')]).toEqual([
			'lib/b/Other.svelte'
		]);
	});

	it('the same-named component the route imports', () => {
		const files: Record<string, string> = {
			'routes/hell/+page.svelte':
				"<script>\n\timport PriceTicker from '$lib/hell/PriceTicker.svelte' with { wake: 'load' };\n\timport Card from './Card.svelte';\n</script>"
		};
		expect([...route_imports(Object.keys(files), (f) => files[f], 'PriceTicker')]).toEqual([
			'lib/hell/PriceTicker.svelte'
		]);
		expect([...route_imports(Object.keys(files), (f) => files[f], 'Card')]).toEqual([
			'routes/hell/Card.svelte'
		]);
	});
});
