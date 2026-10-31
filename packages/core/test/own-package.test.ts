// Core answers to two package names: `ogygia` (what apps install, re-exporting core) and `@ogygia/core`
// (what plugins import). Every "is this ogygia itself" check reads src/own-package.ts.
import { describe, expect, it } from 'vitest';
import { OWN_FILE_RE, OWN_PACKAGE_NAMES, is_own_specifier } from '../src/own-package.ts';
import { source_uses_ogygia_context } from '../src/compiler/link/context-detect.ts';
import { source_crosses_wire } from '../src/compiler/link/transport.ts';
import { summarize_chunk_contents } from '../src/compiler/link/island-deps.ts';

describe('own package identity', () => {
	it('names both packages, and their subpaths', () => {
		expect(OWN_PACKAGE_NAMES).toEqual(['ogygia', '@ogygia/core']);
		for (const spec of ['ogygia', 'ogygia/runtime', '@ogygia/core', '@ogygia/core/plugin/utils'])
			expect(is_own_specifier(spec), spec).toBe(true);
		for (const spec of ['ogygia-x', '@ogygia/content', '@ogygia/core-x', 'svelte'])
			expect(is_own_specifier(spec), spec).toBe(false);
	});

	it('knows its files: the ogygia package, @ogygia/core, a checkout of either, either separator', () => {
		for (const f of [
			'/app/node_modules/ogygia/dist/index.js',
			'/app/node_modules/@ogygia/core/dist/runtime/slots.js',
			'/repo/packages/ogygia/src/index.ts',
			'/repo/packages/core/src/runtime/slots.ts',
			'C:\\repo\\packages\\core\\dist\\runtime\\slots.js'
		])
			expect(OWN_FILE_RE.test(f), f).toBe(true);
		for (const f of [
			'/app/node_modules/@ogygia/content/dist/index.js',
			'/app/src/lib/core/x.ts',
			'/repo/packages/devtools/src/x.ts'
		])
			expect(OWN_FILE_RE.test(f), f).toBe(false);
	});

	it('reads a context provider and a held region imported under either name', () => {
		expect(source_uses_ogygia_context(`import { setContext } from '@ogygia/core';`)).toBe(true);
		expect(source_uses_ogygia_context(`import * as og from '@ogygia/core';\nog.Provide;`)).toBe(
			true
		);
		expect(source_crosses_wire(`import { region } from '@ogygia/core';`)).toBe(true);
		expect(source_crosses_wire(`import { region } from '@ogygia/corex';`)).toBe(false);
	});

	it("counts an installed @ogygia/core as ogygia's runtime in a chunk summary", () => {
		const out = summarize_chunk_contents([
			'/app/node_modules/.pnpm/@ogygia+core@1/node_modules/@ogygia/core/dist/runtime/slots.js',
			'/repo/packages/core/src/ref.ts'
		]);
		expect(out).toEqual(['ogygia runtime']);
	});
});
