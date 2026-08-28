/**
 * The flag inventory — AST-walked, not text-matched (user ruling: `flag` is an ordinary
 * function, so only calls through the module's REAL 'ogygia' bindings count). These tests pin
 * the binding resolution (named / renamed / namespace), the false-positive rejection (a local
 * function named `flag`), svelte script-block line offsets, and the manifest's dedupe+sort.
 */
import { describe, it, expect } from 'vitest';
import { collect_flag_sites, flags_manifest } from '../src/compiler/flags.js';

describe('collect_flag_sites — AST binding resolution', () => {
	it('counts calls through named imports, with names and lines', () => {
		const src = `import { flag, experiment } from 'ogygia';
export const nav = flag('new-nav', { rollout: 10 });
export const mode = experiment('csr-mode', { variants: ['a', 'b'] });
`;
		expect(collect_flag_sites(src, '/app/src/flags.ts', 'src/flags.ts')).toEqual([
			{ name: 'new-nav', kind: 'flag', file: 'src/flags.ts', line: 2 },
			{ name: 'csr-mode', kind: 'experiment', file: 'src/flags.ts', line: 3 }
		]);
	});

	it('follows a RENAMED import (a text sweep would miss this)', () => {
		const src = `import { flag as f } from 'ogygia';
export const x = f('renamed-flag');
`;
		expect(collect_flag_sites(src, '/a/b.ts', 'b.ts')).toEqual([
			{ name: 'renamed-flag', kind: 'flag', file: 'b.ts', line: 2 }
		]);
	});

	it('follows a NAMESPACE import (og.flag)', () => {
		const src = `import * as og from 'ogygia';
export const x = og.flag('ns-flag');
export const y = og.experiment('ns-exp', { variants: ['a'] });
`;
		const names = collect_flag_sites(src, '/a/b.ts', 'b.ts').map((s) => `${s.kind}:${s.name}`);
		expect(names).toEqual(['flag:ns-flag', 'experiment:ns-exp']);
	});

	it("a LOCAL function named `flag` is NOT counted (a text sweep would false-positive)", () => {
		const src = `import { experiment } from 'ogygia';
const flag = (name) => name; // somebody's own helper
export const x = flag('not-ours');
export const real = experiment('ours', { variants: ['a'] });
`;
		expect(collect_flag_sites(src, '/a/b.ts', 'b.ts').map((s) => s.name)).toEqual(['ours']);
	});

	it('a module that never imports ogygia yields nothing', () => {
		expect(collect_flag_sites(`export const flag = () => 'x'; flag('nope');`, '/a/b.ts', 'b.ts')).toEqual([]);
	});

	it('a dynamic first argument is skipped (not inventoriable)', () => {
		const src = `import { flag } from 'ogygia';
export const x = flag(process.env.NAME);
export const y = flag('static-one');
`;
		expect(collect_flag_sites(src, '/a/b.ts', 'b.ts').map((s) => s.name)).toEqual(['static-one']);
	});

	it('svelte: flags inside <script> blocks carry FILE line numbers', () => {
		const src = `<h1>hi</h1>
<script lang="ts">
	import { flag } from 'ogygia';
	const inline = flag('in-svelte');
</script>
`;
		expect(collect_flag_sites(src, '/a/C.svelte', 'src/C.svelte')).toEqual([
			{ name: 'in-svelte', kind: 'flag', file: 'src/C.svelte', line: 4 }
		]);
	});
});

describe('flags_manifest', () => {
	it('dedupes the two build legs and sorts stably', () => {
		const site = { name: 'nav', kind: 'flag' as const, file: 'src/f.ts', line: 2 };
		const other = { name: 'csr', kind: 'experiment' as const, file: 'src/e.ts', line: 1 };
		const m = flags_manifest([site, other, site]); // ssr + client legs both saw `site`
		expect(m.flags).toEqual([other, site]);
		expect(m.names).toEqual(['csr', 'nav']);
	});
});
