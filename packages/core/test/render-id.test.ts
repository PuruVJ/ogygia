// A HOLE'S RENDER IDENTITY (compiler/region/identity.ts `renderId`): what the islands endpoint renders
// — the component alone. A region id also hashes the page-side schedule and the build's salt, so a
// preset edit, a changed `wake`/`prefetch`, or a build with another OGYGIA_SECRET gave every cached
// page's holes ids the new build did not have (`unknown-id`). The render identity is the same across
// all of those, so the new build still answers them; only a moved, renamed or removed component does
// not. The server manifest maps each render identity to the entry that renders it.
import { describe, it, expect } from 'vitest';
import { renderId, regionIdentity, regionId } from '../src/compiler/region/identity.ts';
import {
	server_islands_module,
	server_manifest_module
} from '../src/compiler/link/server-manifest.ts';

const HOLE = 'src/lib/header/holes/MegaMenuHole.svelte';
const mark = (options: Record<string, unknown>) => ({ strategy: 'server', options });

describe('renderId', () => {
	it('is the component alone: schedule, preset settings and salt never change it', () => {
		const a = regionIdentity(HOLE, mark({ when: 'load' }));
		const b = regionIdentity(
			HOLE,
			mark({ when: 'idle', prefetch: 'idle', cacheTtlSec: 3600, margin: '200px' })
		);
		// the wrapper ids differ (schedule, salt) …
		expect(regionId(a)).not.toBe(regionId(b));
		expect(regionId(a, 'salt-one')).not.toBe(regionId(a, 'salt-two'));
		// … the render identity does not
		expect(renderId(a)).toBe(renderId(b));
		expect(renderId(a)).toBe(renderId(HOLE));
	});

	it('another component, or another export of the same file, is another render identity', () => {
		expect(renderId('src/lib/header/holes/SearchBarHole.svelte')).not.toBe(renderId(HOLE));
		expect(renderId('src/lib/holes.ts#Menu')).not.toBe(renderId('src/lib/holes.ts#Search'));
	});

	it('posix whatever the OS separator, 12 hex, never a region id of the same component', () => {
		expect(renderId('src\\lib\\header\\holes\\MegaMenuHole.svelte')).toBe(renderId(HOLE));
		expect(renderId(HOLE)).toMatch(/^[0-9a-f]{12}$/);
		expect(renderId(HOLE)).not.toBe(regionId(regionIdentity(HOLE, mark({}))));
	});
});

describe('the server manifest maps render identities', () => {
	const program = (rows: Array<[iid: string, render?: string]>) =>
		({
			by_id: new Map(rows.map(([iid]) => [iid, `virtual:${iid}`])),
			registry: new Map(
				rows.map(([iid, render]) => [
					`virtual:${iid}`,
					{ server: true, componentPath: '/x/Hole.svelte', ...(render ? { renderId: render } : {}) }
				])
			)
		}) as never;

	it('each id → its render identity; each render identity → one entry rendering it (the smallest id)', () => {
		const src = server_manifest_module(
			true,
			program([
				['bbbbbbbbbbbb', 'r00000000001'],
				['aaaaaaaaaaaa', 'r00000000001'],
				['cccccccccccc', 'r00000000002']
			]),
			false,
			() => '',
			() => ''
		);
		expect(src).toContain('"bbbbbbbbbbbb": "r00000000001"');
		expect(src).toContain('"aaaaaaaaaaaa": "r00000000001"');
		expect(src).toMatch(
			/render_island = \{\n {2}"r00000000001": "aaaaaaaaaaaa",\n {2}"r00000000002": "cccccccccccc"\n\}/
		);
	});

	it('the islands’ loaders live one dynamic import away (Kit links CSS one import deep)', () => {
		const p = program([['aaaaaaaaaaaa', 'r00000000001']]);
		const manifest = server_manifest_module(
			true,
			p,
			false,
			() => '',
			() => ''
		);
		expect(manifest).toContain(
			`export const load_islands = () => import("virtual:ogygia/server-islands");`
		);
		expect(manifest).not.toContain('import("virtual:aaaaaaaaaaaa")');
		expect(server_islands_module(true, p)).toContain(
			'"aaaaaaaaaaaa": () => import("virtual:aaaaaaaaaaaa")'
		);
		expect(server_islands_module(false, p)).toBe('export const islands = {\n\n};\n');
	});

	it('the browser leg carries none of it', () => {
		const src = server_manifest_module(
			false,
			program([['aaaaaaaaaaaa', 'r00000000001']]),
			false,
			() => '',
			() => ''
		);
		expect(src).toContain('export const island_render = {};');
		expect(src).toContain('export const render_island = {};');
	});
});
