import { describe, expect, it } from 'vitest';
import {
	needs_csr_false_full_reload,
	needs_island_entry_full_reload,
	same_module_path,
	island_vpaths_affected_by_file
} from '../dist/compiler/dev/hmr.js';
import { dev_hmr_client_source } from '../dist/compiler/dev/dev-hmr.js';
import { derive_css_scope_owners } from '../dist/compiler/dev/css-scope.js';
import { rewrite_island_sourcemap_sources } from '../dist/vite/sourcemaps.js';

describe('needs_csr_false_full_reload', () => {
	it('reloads host route shells (SSR-only under csr=false)', () => {
		expect(needs_csr_false_full_reload('/app/src/routes/+page.svelte')).toBe(true);
		expect(needs_csr_false_full_reload('/app/src/routes/+layout.svelte')).toBe(true);
		expect(needs_csr_false_full_reload('/app/src/routes/blog/+page.server.ts')).toBe(true);
		expect(needs_csr_false_full_reload('C:\\app\\src\\routes\\+layout.ts')).toBe(true);
	});

	it('does not reload standalone CSS (dev-hmr joins the client graph)', () => {
		expect(needs_csr_false_full_reload('/app/src/app.css')).toBe(false);
		expect(needs_csr_false_full_reload('/app/src/fonts.scss')).toBe(false);
	});

	it('does not reload island / lib components by path alone (registry decides)', () => {
		expect(needs_csr_false_full_reload('/app/src/lib/SideNav.svelte')).toBe(false);
		expect(needs_csr_false_full_reload('/app/src/lib/demos/Counter.svelte')).toBe(false);
	});
});

describe('needs_island_entry_full_reload', () => {
	const entries = [
		{ componentPath: '/app/src/lib/SideNav.svelte' },
		{ componentPath: '/app/src/lib/Counter.svelte' }
	];

	it('reloads registered island entry .svelte files', () => {
		expect(needs_island_entry_full_reload('/app/src/lib/SideNav.svelte', entries)).toBe(true);
	});

	it('does not reload shared .ts deps or unrelated svelte', () => {
		expect(needs_island_entry_full_reload('/app/src/lib/toc-items.ts', entries)).toBe(false);
		expect(needs_island_entry_full_reload('/app/src/lib/Other.svelte', entries)).toBe(false);
	});
});

describe('same_module_path', () => {
	it('compares absolute paths ignoring querystrings', () => {
		expect(same_module_path('/app/src/lib/A.svelte', '/app/src/lib/A.svelte?v=1')).toBe(true);
		expect(same_module_path('/app/src/lib/A.svelte', '/app/src/lib/B.svelte')).toBe(false);
		expect(same_module_path(null, '/app/x')).toBe(false);
	});
});

describe('island_vpaths_affected_by_file', () => {
	const entries: [string, { hostPath?: string; componentPath?: string | null }][] = [
		[
			'virtual:ogygia/island/aaa.svelte',
			{ hostPath: '/app/src/routes/+layout.svelte', componentPath: '/app/src/lib/SiteNav.svelte' }
		],
		[
			'virtual:ogygia/island/bbb.svelte',
			{ hostPath: '/app/src/routes/+page.svelte', componentPath: '/app/src/lib/Counter.svelte' }
		]
	];

	it('matches host renames that keep the same island id slot', () => {
		expect(island_vpaths_affected_by_file('/app/src/routes/+layout.svelte', entries)).toEqual([
			'virtual:ogygia/island/aaa.svelte'
		]);
	});

	it('matches deleted / renamed entry components (SiteNav → SideNav stale graph)', () => {
		expect(island_vpaths_affected_by_file('/app/src/lib/SiteNav.svelte', entries)).toEqual([
			'virtual:ogygia/island/aaa.svelte'
		]);
	});

	it('ignores unrelated lib files', () => {
		expect(island_vpaths_affected_by_file('/app/src/lib/Other.svelte', entries)).toEqual([]);
	});
});

describe('dev_hmr_client_source', () => {
	it('wires scoped soft CSS HMR and hard full-reload on vite:error', () => {
		const src = dev_hmr_client_source();
		expect(src).toContain('import "/@vite/client"');
		expect(src).toContain('import.meta.glob("/src/**/*.{css,scss,sass,less,styl}"');
		// LAZY, not eager — an eager whole-app join paints every sub-app with every other's skin.
		expect(src).toContain('{ eager: false }');
		expect(src).not.toContain('{ eager: true }');
		// Joins are scope-gated by the handle-stamped meta + the plugin's ogygia:css broadcast.
		expect(src).toContain('ogygia-dev-scope');
		expect(src).toContain('ogygia:css');
		expect(src).toContain('vite:error');
		expect(src).toContain('location.reload()');
		// Must NOT strip Kit FOUC — under csr=false that bag is the page CSS.
		expect(src).not.toContain('data-sveltekit');
		expect(src).not.toContain('MutationObserver');
	});
});

describe('derive_css_scope_owners', () => {
	type Mod = { file?: string | null; importers?: Mod[] };
	const graph_of = (roots: Map<string, Mod[]>) => ({
		getModulesByFile: (f: string) => (roots.has(f) ? new Set(roots.get(f)) : undefined)
	});

	it('walks importers up to route files and reports their top-level scopes', () => {
		const docs_layout: Mod = { file: '/app/src/routes/(docs)/+layout.svelte' };
		const css: Mod = { file: '/app/src/app.css', importers: [docs_layout] };
		const owners = derive_css_scope_owners('/app/src/app.css', '/app', [
			graph_of(new Map([['/app/src/app.css', [css]]]))
		]);
		expect(owners).toEqual(['(docs)']);
	});

	it('reaches route files through intermediate lib modules and dedupes scopes', () => {
		const pg_page: Mod = { file: '/app/src/routes/playground/+page.svelte' };
		const pg_layout: Mod = { file: '/app/src/routes/playground/+layout.svelte' };
		const lib: Mod = {
			file: '/app/src/lib/playground/thing.svelte',
			importers: [pg_page, pg_layout]
		};
		const css: Mod = { file: '/app/src/lib/playground/thing.css', importers: [lib] };
		const owners = derive_css_scope_owners('/app/src/lib/playground/thing.css', '/app', [
			graph_of(new Map([['/app/src/lib/playground/thing.css', [css]]]))
		]);
		expect(owners).toEqual(['playground']);
	});

	it('a root-level route file owns the empty scope; shared css lists every owner', () => {
		const root_layout: Mod = { file: '/app/src/routes/+layout.svelte' };
		const docs_err: Mod = { file: '/app/src/routes/(docs)/+error.svelte' };
		const css: Mod = { file: '/app/src/shared.css', importers: [root_layout, docs_err] };
		const owners = derive_css_scope_owners('/app/src/shared.css', '/app', [
			graph_of(new Map([['/app/src/shared.css', [css]]]))
		]);
		expect(owners).toEqual(['', '(docs)']);
	});

	it('no route owner found → empty (client treats as shared)', () => {
		const orphan: Mod = { file: '/app/src/lib/orphan.css', importers: [] };
		expect(
			derive_css_scope_owners('/app/src/lib/orphan.css', '/app', [
				graph_of(new Map([['/app/src/lib/orphan.css', [orphan]]]))
			])
		).toEqual([]);
	});

	it('survives importer cycles', () => {
		const a: Mod = { file: '/app/src/lib/a.ts' };
		const b: Mod = { file: '/app/src/lib/b.ts', importers: [a] };
		a.importers = [b];
		const css: Mod = { file: '/app/src/x.css', importers: [a] };
		expect(
			derive_css_scope_owners('/app/src/x.css', '/app', [
				graph_of(new Map([['/app/src/x.css', [css]]]))
			])
		).toEqual([]);
	});
});

describe('rewrite_island_sourcemap_sources', () => {
	it('rewrites basename-only svelte sources to the virtual module id', () => {
		const id = 'virtual:ogygia/island/abc123.svelte';
		expect(rewrite_island_sourcemap_sources(id, ['abc123.svelte'])).toEqual([id]);
		expect(rewrite_island_sourcemap_sources(id, [id])).toBeNull();
		expect(rewrite_island_sourcemap_sources(id, ['/abs/real.svelte'])).toBeNull();
	});
});
