import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewrite_regions, region_key } from '../src/compiler/content/regions.js';

let dir: string;
let registry_id: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-regions-'));
	fs.mkdirSync(path.join(dir, 'blocks'));
	for (const name of ['Hero.svelte', 'Prose.svelte', 'Callout.svelte', 'hero-banner.svelte']) {
		fs.writeFileSync(path.join(dir, 'blocks', name), '<h1>block</h1>');
	}
	registry_id = path.join(dir, 'registry.ts');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('region_key', () => {
	it('is the basename verbatim, minus extension (no normalization)', () => {
		expect(region_key('/x/Hero.svelte')).toBe('Hero');
		expect(region_key('/x/hero-banner.svelte')).toBe('hero-banner');
		expect(region_key('/x/call_to_action.svelte')).toBe('call_to_action');
	});
});

describe('rewrite_regions', () => {
	it('globs the folder and emits raw-region imports + a basename-keyed object', () => {
		const src = `export const registry = import.meta.og.regions('./blocks/*.svelte');`;
		const out = rewrite_regions(src, registry_id);
		// one import per match, each a raw region
		expect((out.match(/with \{ region: 'raw' \}/g) ?? []).length).toBe(4);
		expect(out).toContain(`import __og_region_0 from "./blocks/Callout.svelte" with { region: 'raw' };`);
		// object keyed by basename (sorted → Callout, Hero, HeroBanner, Prose)
		expect(out).toContain(`"Callout": __og_region_0`);
		expect(out).toContain(`"hero-banner":`);
		expect(out).toContain(`export const registry = {`);
		expect(out).not.toContain('import.meta.og.regions');
	});

	it('leaves a module with no regions() call untouched (same reference)', () => {
		const src = `export const x = 1;`;
		expect(rewrite_regions(src, registry_id)).toBe(src);
	});

	it('ignores the marker in a comment or string', () => {
		const src = [
			`// import.meta.og.regions('./blocks/*.svelte')`,
			`const s = "import.meta.og.regions('x')";`,
			`export const r = import.meta.og.regions('./blocks/Hero.svelte');`
		].join('\n');
		const out = rewrite_regions(src, registry_id);
		expect((out.match(/with \{ region: 'raw' \}/g) ?? []).length).toBe(1); // only the real call
		expect(out).toContain(`// import.meta.og.regions('./blocks/*.svelte')`);
	});

	it('throws build-voice on a duplicate key (same basename in nested dirs)', () => {
		const dupdir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-regions-dup-'));
		fs.mkdirSync(path.join(dupdir, 'b'));
		fs.mkdirSync(path.join(dupdir, 'b', 'sub'));
		fs.writeFileSync(path.join(dupdir, 'b', 'Hero.svelte'), 'x');
		fs.writeFileSync(path.join(dupdir, 'b', 'sub', 'Hero.svelte'), 'x');
		try {
			expect(() => rewrite_regions(`export const r = import.meta.og.regions('./b/**/*.svelte');`, path.join(dupdir, 'r.ts'))).toThrow(
				/two files map to the block key 'Hero'/
			);
		} finally {
			fs.rmSync(dupdir, { recursive: true, force: true });
		}
	});

	it('rejects a non-literal glob argument', () => {
		expect(() => rewrite_regions('const r = import.meta.og.regions(dir + "/*.svelte");', registry_id)).toThrow(
			/must be a static string literal/
		);
	});
});
