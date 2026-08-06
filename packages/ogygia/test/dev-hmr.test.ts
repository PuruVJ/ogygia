import { describe, expect, it } from 'vitest';
import {
	needs_csr_false_full_reload,
	needs_island_entry_full_reload,
	dev_hmr_client_source,
	same_module_path,
	island_vpaths_affected_by_file
} from '../dist/vite/index.js';

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
	it('wires soft CSS HMR and hard full-reload on vite:error', () => {
		const src = dev_hmr_client_source();
		expect(src).toContain('import "/@vite/client"');
		expect(src).toContain('import.meta.glob("/src/**/*.{css,scss,sass,less,styl}"');
		expect(src).toContain('style[data-sveltekit]');
		expect(src).toContain('vite:error');
		expect(src).toContain('location.reload()');
	});
});
