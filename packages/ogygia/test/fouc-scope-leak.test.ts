/**
 * REGRESSION: a lake's (and island's) component-scoped CSS must ship SCOPED (`.x.svelte-<hash>`), never
 * global (`.x`). The client CSS handoff for a `wake:'none'` region is `virtual:ogygia/fouc-scoped/<rel>.css`,
 * served by compiling the component's scoped CSS. The bug: that path compiled the RAW source with the
 * `<script>` stripped and no preprocessor, so a `<style lang="scss">` component (Svelte can't parse scss)
 * or a template that references a store/script name (compile throws once the script is gone) fell back to
 * shipping the style bodies UNSCOPED — global rules that then matched any element on the page reusing the
 * class (a header lake restyled an unrelated breadcrumb's `.breadcrumb-header-inner`). The fix routes the
 * same source through the preprocessor and KEEPS the script, exactly as the hole-CSS leg already did.
 *
 * These pin the compile step both ways: the bare call still reproduces the unscoped leak, and the
 * preprocess + keepScript call (what the plugin now does) stays scoped.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFoucScopedCss } from '../src/compiler/fouc-css.js';
import { preprocess_component_for_css } from '../src/vite/style-preprocess.js';

// The ogygia package root — where `sass-embedded` (a devDependency) resolves, the way the real plugin
// resolves sass from the app root.
const pkg_root = fileURLToPath(new URL('../', import.meta.url));
const abs = path.join(pkg_root, 'src', 'lib', 'Header.svelte');
const SCOPE_HASH = /\.svelte-[a-z0-9]+/i;

// A template that reads a STORE from an imported name — stripping the script (the old default) makes
// svelte.compile throw, so the CSS fell back to unscoped bodies.
const STORE_REF = [
	`<script>import { open } from './state.js';</script>`,
	`<div class="breadcrumb-header-inner">{$open}</div>`,
	`<style>.breadcrumb-header-inner{display:flex;width:100%;max-width:1424px;margin:auto}</style>`
].join('\n');

// scss-only syntax ($var) — svelte.compile can't read scss, so it threw too.
const SCSS = [
	`<div class="breadcrumb-header-inner"><span class="green-header">x</span></div>`,
	`<style lang="scss">$w: 100%; .breadcrumb-header-inner{width:$w;display:flex} .green-header{color:green}</style>`
].join('\n');

describe('fouc-scoped CSS: a lake/island keeps Svelte scoping and never leaks global', () => {
	it('a bare compile (no keepScript) of a store-referencing component is scoped too', () => {
		// it used to strip the script first → compile threw → raw bodies, global; the dev router leg
		// takes this path, and shipped 11 of the profiler's 37 styled components unscoped
		const css = compileFoucScopedCss(abs, STORE_REF);
		expect(css).toContain('.breadcrumb-header-inner');
		expect(css).toMatch(SCOPE_HASH);
	});

	it('a fallback that ships unscoped says so in the CSS, with the file name only', async () => {
		const { find_unscoped } = await import('../src/unscoped-css.js');
		const css = compileFoucScopedCss(abs, SCSS);
		expect(find_unscoped(css)).toEqual([{ file: 'Header.svelte', why: expect.any(String) }]);
		expect(css).not.toContain(pkg_root); // never the build machine's path
	});

	it('FIX — keepScript compiles the same component to scoped selectors', () => {
		const css = compileFoucScopedCss(abs, STORE_REF, { keepScript: true });
		expect(css).toContain('.breadcrumb-header-inner');
		expect(css).toMatch(SCOPE_HASH);
	});

	it('BUG REPRO — bare compile of a <style lang="scss"> component ships UNSCOPED', () => {
		const css = compileFoucScopedCss(abs, SCSS); // svelte can't parse scss → throws → raw bodies
		expect(css).not.toMatch(SCOPE_HASH);
	});

	it('FIX — preprocess (scss→css) + keepScript compiles to scoped selectors', async () => {
		const pre = await preprocess_component_for_css(SCSS, abs, pkg_root);
		const css = compileFoucScopedCss(abs, pre, { keepScript: true });
		expect(css).toContain('.breadcrumb-header-inner');
		expect(css).toContain('.green-header');
		expect(css).toMatch(SCOPE_HASH);
		expect(css).not.toContain('$w'); // the scss variable is resolved, not shipped literally
	});

	it('TypeScript in the MARKUP (a typed arrow) still compiles scoped', async () => {
		// the script's TS was stripped and its lang="ts" dropped with it, so a typed arrow in the
		// template threw "Unexpected token" and the whole component's CSS shipped global (found on the
		// profiler's report page: a ledger's `.bar` rule dimmed the timeline's `.bar`)
		const TS_MARKUP = [
			`<script lang="ts">type Row = { n: number }; let { rows }: { rows: Row[] } = $props();</script>`,
			`<span class="bar">{rows.map((r: Row) => r.n).join(',')}</span>`,
			`<style>.bar{position:absolute;height:2px}</style>`
		].join('\n');
		const pre = await preprocess_component_for_css(TS_MARKUP, abs, pkg_root);
		const css = compileFoucScopedCss(abs, pre, { keepScript: true });
		expect(css).toMatch(/\.bar\.svelte-[a-z0-9]+/i);
	});

	it('the two scoped classes carry the SAME hash (one component, one scope)', async () => {
		const pre = await preprocess_component_for_css(SCSS, abs, pkg_root);
		const css = compileFoucScopedCss(abs, pre, { keepScript: true });
		const hashes = new Set([...css.matchAll(/\.svelte-([a-z0-9]+)/gi)].map((m) => m[1]));
		expect(hashes.size).toBe(1);
	});
});
