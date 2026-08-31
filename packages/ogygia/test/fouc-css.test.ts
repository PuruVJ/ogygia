import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
	buildFoucCssModuleSource,
	compileFoucScopedCss,
	foucCssVirtualId,
	foucScopedVirtualId,
	listStaticImportSpecs
} from '../dist/compiler/fouc-css.js';

describe('fouc-css collector', () => {
	const root = '/app';
	const libDir = '/app/src/lib';

	test('foucCssVirtualId normalizes separators', () => {
		expect(foucCssVirtualId('src/lib/A.svelte')).toBe(
			'virtual:ogygia/fouc-css/' + encodeURIComponent('src/lib/A.svelte') + '.js'
		);
		expect(foucScopedVirtualId('src\\lib\\A.svelte')).toBe(
			'virtual:ogygia/fouc-scoped/' + encodeURIComponent('src/lib/A.svelte') + '.css'
		);
	});

	test('walks child .svelte + plain css without emitting component JS', () => {
		const files: Record<string, string> = {
			'/app/src/lib/Hero.svelte': `<script>\nimport Demo from './Demo.svelte';\nimport './x.css';\n</script>\n<Demo />\n`,
			'/app/src/lib/Demo.svelte': `<script></script>\n<style>.d { color: red }</style>\n<div class="d"></div>\n`,
			'/app/src/lib/x.css': `.x { color: blue }`
		};
		const src = buildFoucCssModuleSource('/app/src/lib/Hero.svelte', {
			root,
			libDir,
			readFile: (p) => files[path.normalize(p)] ?? null
		});
		expect(src).toContain('import "/app/src/lib/x.css";');
		expect(src).toContain(`import "${foucScopedVirtualId('src/lib/Demo.svelte')}";`);
		expect(src).not.toMatch(/from ["'].*\.svelte["']/);
	});

	test('compileFoucScopedCss keeps filename-scoped output', () => {
		const abs = '/app/src/lib/Side.svelte';
		const css = compileFoucScopedCss(
			abs,
			`<script lang="ts">let x: number = 1;</script>\n<style>.side { display: block }</style>\n<div class="side"></div>\n`
		);
		expect(css).toMatch(/\.side/);
		expect(css.length).toBeGreaterThan(0);
	});

	test('listStaticImportSpecs reads side-effect css imports', () => {
		const specs = listStaticImportSpecs(
			`<script>\nimport '$lib/styles/a.css';\nimport B from './B.svelte';\n</script>\n`,
			'/app/src/lib/H.svelte'
		);
		expect(specs).toContain('$lib/styles/a.css');
		expect(specs).toContain('./B.svelte');
	});
});
