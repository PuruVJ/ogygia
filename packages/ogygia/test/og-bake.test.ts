import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewrite_bake } from '../src/compiler/macros/bake.js';
import { __set_build_cache_root } from '../src/build-cache.js';

__set_build_cache_root(fs.mkdtempSync(path.join(os.tmpdir(), 'og-bake-cache-')));
const NO_ALIAS = { alias: [], root: '/app' };

describe('rewrite_bake — validation (no execution)', () => {
	it('rejects a non-function argument', async () => {
		await expect(rewrite_bake('const x = import.meta.og.bake(42);', '/app/x.ts', NO_ALIAS)).rejects.toThrow(
			/the argument must be a function/
		);
	});
	it('rejects wrong arity', async () => {
		await expect(rewrite_bake('const x = import.meta.og.bake(() => 1, 2);', '/app/x.ts', NO_ALIAS)).rejects.toThrow(
			/takes exactly one argument/
		);
	});
	it('returns the same reference when there is no bake call', async () => {
		const src = 'export const x = 1;';
		expect(await rewrite_bake(src, '/app/x.ts', NO_ALIAS)).toBe(src);
	});
	it('ignores the marker inside a comment or string', async () => {
		const src = '// import.meta.og.bake(() => 1)\nconst s = "import.meta.og.bake(x)";\nexport const y = 2;';
		expect(await rewrite_bake(src, '/app/x.ts', NO_ALIAS)).toBe(src);
	});
});

describe('rewrite_bake — real build-time evaluation', () => {
	let dir: string;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bake-e2e-'));
		fs.writeFileSync(
			path.join(dir, 'data.ts'),
			`export function buildNav(): { items: string[]; count: number; when: Date } {
				return { items: ['home', 'about'], count: 2, when: new Date(0) };
			}
			export const HELPER_ONLY = 7;`
		);
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	const opts = () => ({ alias: [], root: dir });

	it('executes an imported fn at build and inlines its devalue-serialized result (Date survives)', async () => {
		const src = [
			`import { buildNav } from './data';`,
			`const nav = import.meta.og.bake(() => buildNav());`,
			`export { nav };`
		].join('\n');
		const out = await rewrite_bake(src, path.join(dir, 'mod.ts'), opts());
		expect(out).not.toContain('import.meta.og.bake');
		expect(out.replace(/\s/g, '')).toContain('items:["home","about"]');
		expect(out).toContain('new Date(0)');
	});

	it('awaits an async bake fn', async () => {
		const src = `const n = import.meta.og.bake(async () => 40 + 2);\nexport { n };`;
		const out = await rewrite_bake(src, path.join(dir, 'mod.ts'), opts());
		expect(out).toContain('const n = (42)');
	});

	it('drops an import that only fed a baked fn (ship the answer, not the computation)', async () => {
		const src = [
			`import { buildNav } from './data';`,
			`const nav = import.meta.og.bake(() => buildNav().count);`,
			`export { nav };`
		].join('\n');
		const out = await rewrite_bake(src, path.join(dir, 'mod.ts'), opts());
		expect(out).not.toContain(`import { buildNav }`); // dead after baking → removed
		expect(out).toContain('const nav = (2)');
	});

	it('KEEPS an import still used outside the baked fn', async () => {
		const src = [
			`import { buildNav, HELPER_ONLY } from './data';`,
			`const nav = import.meta.og.bake(() => buildNav().count);`,
			`export const extra = HELPER_ONLY;`, // still used → import must stay
			`export { nav };`
		].join('\n');
		const out = await rewrite_bake(src, path.join(dir, 'mod.ts'), opts());
		expect(out).toContain(`import { buildNav, HELPER_ONLY } from './data';`);
		expect(out).toContain('const nav = (2)');
	});

	it('a non-serializable result is a build error naming the fix', async () => {
		const src = `const bad = import.meta.og.bake(() => () => 1);\nexport { bad };`;
		await expect(rewrite_bake(src, path.join(dir, 'mod.ts'), opts())).rejects.toThrow(/not serializable/);
	});
});
