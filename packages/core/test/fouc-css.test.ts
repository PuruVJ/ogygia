import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
	buildFoucCssModuleSource,
	collectFoucCssReachable,
	compileFoucScopedCss,
	foucCssVirtualId,
	foucScopedVirtualId,
	listStaticImports
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

	test('walks child .svelte + plain css without emitting component JS', async () => {
		const files: Record<string, string> = {
			'/app/src/lib/Hero.svelte': `<script>\nimport Demo from './Demo.svelte';\nimport './x.css';\n</script>\n<Demo />\n`,
			'/app/src/lib/Demo.svelte': `<script></script>\n<style>.d { color: red }</style>\n<div class="d"></div>\n`,
			'/app/src/lib/x.css': `.x { color: blue }`
		};
		const src = await buildFoucCssModuleSource('/app/src/lib/Hero.svelte', {
			root,
			libDir,
			readFile: (p) => files[path.normalize(p)] ?? null
		});
		expect(src).toContain('import "/app/src/lib/x.css";');
		expect(src).toContain(`import "${foucScopedVirtualId('src/lib/Demo.svelte')}";`);
		expect(src).not.toMatch(/from ["'].*\.svelte["']/);
	});

	// REGRESSION (field report, 0.8.x): a hole's flyout, taken from a workspace package whose
	// `exports` point at a TypeScript barrel, arrived unstyled — the specifier did not resolve, and a
	// `.ts` module was a dead end. The bundler's resolver resolves it; a barrel is followed by name.
	test('a package barrel and a local barrel: the names taken, and only those', async () => {
		const files: Record<string, string> = {
			'/app/src/lib/Menu.svelte': `<script lang="ts">import { KitPanel, type KitProps } from '@kit/ui/components';\nimport { LocalBadge } from './bits/index';\n</script>\n<KitPanel /><LocalBadge />`,
			'/kit/components.ts': `import KitPanel from './src/KitPanel.svelte';\nexport { KitPanel };\nexport { default as KitUnused } from './src/KitUnused.svelte';\nexport * from './more';\nexport type KitProps = { a: number };`,
			'/kit/more.ts': `export { default as KitDeep } from './src/KitDeep.svelte';`,
			'/kit/src/KitPanel.svelte': `<div class="p"></div><style>.p { color: red }</style>`,
			'/kit/src/KitUnused.svelte': `<div class="u"></div><style>.u { color: red }</style>`,
			'/kit/src/KitDeep.svelte': `<div class="d"></div><style>.d { color: red }</style>`,
			'/app/src/lib/bits/index.ts': `export { default as LocalBadge } from './LocalBadge.svelte';\nexport { default as LocalUnused } from './LocalUnused.svelte';`,
			'/app/src/lib/bits/LocalBadge.svelte': `<b class="b"></b><style>.b { color: red }</style>`,
			'/app/src/lib/bits/LocalUnused.svelte': `<b class="x"></b><style>.x { color: red }</style>`
		};
		// (the bundler's resolver: a package through its `exports`, extensionless relative paths)
		const resolve = async (spec: string, importer: string) => {
			if (spec === '@kit/ui/components') return '/kit/components.ts';
			const base = path.resolve(path.dirname(importer), spec);
			for (const s of ['', '.ts', '/index.ts']) if (files[base + s] != null) return base + s;
			return null;
		};
		const reached = await collectFoucCssReachable('/app/src/lib/Menu.svelte', {
			root,
			libDir,
			readFile: (p) => files[path.normalize(p)] ?? null,
			resolve
		});
		const names = reached.map((e) => path.basename(e.abs));
		expect(names).toContain('KitPanel.svelte');
		expect(names).toContain('LocalBadge.svelte');
		// the barrels' other components bring nothing
		expect(names).not.toContain('KitUnused.svelte');
		expect(names).not.toContain('KitDeep.svelte');
		expect(names).not.toContain('LocalUnused.svelte');
	});

	test('a module with code of its own brings every component it imports', async () => {
		const files: Record<string, string> = {
			'/app/src/lib/Page.svelte': `<script>import { pick } from './pick';\n</script>{pick()}`,
			'/app/src/lib/pick.ts': `import A from './A.svelte';\nimport B from './B.svelte';\nexport const pick = () => (Math.random() > 0.5 ? A : B);`,
			'/app/src/lib/A.svelte': `<i class="a"></i><style>.a { color: red }</style>`,
			'/app/src/lib/B.svelte': `<i class="b"></i><style>.b { color: red }</style>`
		};
		const reached = await collectFoucCssReachable('/app/src/lib/Page.svelte', {
			root,
			libDir,
			readFile: (p) => files[path.normalize(p)] ?? null
		});
		expect(reached.map((e) => path.basename(e.abs)).sort()).toEqual(['A.svelte', 'B.svelte']);
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

	test('listStaticImports reads side-effect css imports and the names taken', () => {
		const imports = listStaticImports(
			`<script lang="ts">\nimport '$lib/styles/a.css';\nimport B from './B.svelte';\nimport { C, type T } from './kit';\nimport type { U } from './types';\n</script>\n`,
			'/app/src/lib/H.svelte'
		);
		const by = new Map(imports.map((i) => [i.source, [...i.names]]));
		expect(by.get('$lib/styles/a.css')).toEqual([]);
		expect(by.get('./B.svelte')).toEqual(['default']);
		expect(by.get('./kit')).toEqual(['C']);
		expect(by.has('./types')).toBe(false);
	});
});
