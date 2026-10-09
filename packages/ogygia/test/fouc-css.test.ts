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

	test('raw-fallback CSS is valid: :global(...) is unwrapped, not left literal', () => {
		// Stripping the <script> (the default) makes svelte.compile throw on a template that reads a
		// script-declared name, so compileFoucScopedCss falls back to the raw <style> bodies. Those
		// carry `:global(...)`, which is a Svelte construct — left literal the browser drops the whole
		// rule (a header lake once lost its `:global(x-web-header.scrolled-top)` height reservation).
		const css = compileFoucScopedCss(
			'/app/src/lib/Header.svelte',
			`<script>import { s } from './s.js';</script>\n<p>{$s}</p>\n` +
				`<style>@media (min-width: 1025px) { :global(x-web-header.scrolled-top:not(.client-mounted)) { min-height: 161px } }</style>`
		);
		expect(css).not.toContain(':global(');
		expect(css).toContain('x-web-header.scrolled-top:not(.client-mounted)');
		expect(css).toContain('161px');
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
