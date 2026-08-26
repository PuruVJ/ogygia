/**
 * Server-router component CSS (link/router-css.ts): the closure walker that finds every `.svelte` a
 * router module can reach (barrels included), and the generated `virtual:ogygia/router-css` source
 * for both modes. The runtime registry (router-css.ts) is exercised through the same shapes the
 * virtual emits. End-to-end (build → handoff → linked page) is covered by the playground rtr fixture.
 */
import { describe, expect, it } from 'vitest';
import {
	router_css_roots,
	router_css_module,
	router_css_key
} from '../src/compiler/link/router-css.js';
import {
	register_router_css,
	register_router_css_paths,
	router_css_of
} from '../src/router-css.js';

const ROOT = '/app';
const LIB = '/app/src/lib';

/** In-memory module graph: path → import specs; `.svelte`/`.ts` existence from the map's keys. */
function graph(files: Record<string, string[]>) {
	const specs = new Map(Object.entries(files));
	const exists = (p: string) => specs.has(p);
	return { specs, exists };
}

describe('router_css_roots — the component closure of router modules', () => {
	it('collects direct .svelte imports', () => {
		const { specs, exists } = graph({
			'/app/src/routes/x/+server.ts': ['ogygia/router', './Shell.svelte', '$lib/Home.svelte'],
			'/app/src/routes/x/Shell.svelte': [],
			'/app/src/lib/Home.svelte': []
		});
		const roots = router_css_roots(new Set(['/app/src/routes/x/+server.ts']), specs, LIB, exists);
		expect(roots).toEqual(['/app/src/lib/Home.svelte', '/app/src/routes/x/Shell.svelte']);
	});

	it('follows barrels (re-exports) to their .svelte leaves', () => {
		const { specs, exists } = graph({
			'/app/src/app.ts': ['ogygia/router', './pages/index.ts'],
			'/app/src/pages/index.ts': ['./Home.svelte', './deep/index.ts'],
			'/app/src/pages/Home.svelte': [],
			'/app/src/pages/deep/index.ts': ['./Docs.svelte'],
			'/app/src/pages/deep/Docs.svelte': []
		});
		const roots = router_css_roots(new Set(['/app/src/app.ts']), specs, LIB, exists);
		expect(roots).toEqual(['/app/src/pages/Home.svelte', '/app/src/pages/deep/Docs.svelte']);
	});

	it('resolves extensionless + index barrels', () => {
		const { specs, exists } = graph({
			'/app/src/r.ts': ['ogygia/router', './components'],
			'/app/src/components/index.ts': ['./Card.svelte'],
			'/app/src/components/Card.svelte': []
		});
		const roots = router_css_roots(new Set(['/app/src/r.ts']), specs, LIB, exists);
		expect(roots).toEqual(['/app/src/components/Card.svelte']);
	});

	it('skips package imports and survives import cycles', () => {
		const { specs, exists } = graph({
			'/app/src/a.ts': ['ogygia/router', 'some-pkg', './b.ts'],
			'/app/src/b.ts': ['./a.ts', './X.svelte'],
			'/app/src/X.svelte': []
		});
		const roots = router_css_roots(new Set(['/app/src/a.ts']), specs, LIB, exists);
		expect(roots).toEqual(['/app/src/X.svelte']);
	});

	it('no router modules → no roots', () => {
		const { specs, exists } = graph({ '/app/src/a.ts': ['./X.svelte'], '/app/src/X.svelte': [] });
		expect(router_css_roots(new Set(), specs, LIB, exists)).toEqual([]);
	});
});

describe('router_css_module — the generated virtual', () => {
	const read = (files: Record<string, string>) => (p: string) => files[p] ?? null;

	it('emits an inert module for zero roots', () => {
		expect(
			router_css_module([], { root: ROOT, lib_dir: LIB, is_dev: false, read_file: () => null })
		).toBe('export {};\n');
	});

	it('prod: registers each root with a handoff thunk (islandCss key + $app/paths base)', () => {
		const src = router_css_module(['/app/src/lib/Shell.svelte'], {
			root: ROOT,
			lib_dir: LIB,
			is_dev: false,
			read_file: () => null
		});
		expect(src).toContain(`import __OgRcss0 from "/app/src/lib/Shell.svelte";`);
		expect(src).toContain(`islandCss("rcss:src/lib/Shell.svelte")`);
		expect(src).toContain(`from 'virtual:ogygia/island-deps'`);
		expect(src).toContain(`from '$app/paths'`);
		expect(src).toContain(`register_router_css(__OgRcss0`);
	});

	it('dev: inlines compiled scoped css (transitively, through child components)', () => {
		const files: Record<string, string> = {
			'/app/src/lib/Shell.svelte':
				`<script>import Badge from './Badge.svelte';</script>` +
				`<div class="shell"><Badge/></div><style>.shell { color: red; }</style>`,
			'/app/src/lib/Badge.svelte': `<b class="badge">!</b><style>.badge { color: blue; }</style>`
		};
		const src = router_css_module(['/app/src/lib/Shell.svelte'], {
			root: ROOT,
			lib_dir: LIB,
			is_dev: true,
			read_file: read(files)
		});
		expect(src).toContain('.shell');
		expect(src).toContain('.badge'); // the CHILD's css rides the root's registration
		expect(src).toContain('rcss-dev:src/lib/Shell.svelte');
		expect(src).toContain('rcss-dev:src/lib/Badge.svelte');
		expect(src).not.toContain('islandCss'); // dev never touches the build handoff
		// STRUCTURAL: the dev virtual must be pure data — a component import here would weld the whole
		// router-page tree into graph territory SvelteKit's dev css collector can crawl from any page,
		// leaking router stylesheets into unrelated pages (seen in the wild via the profiler's UI).
		expect(src).not.toContain('import __OgRcss');
		expect(src).not.toContain('from "/app'); // no module imports of app files at all
		expect(src).toContain('register_router_css_paths(m)');
		// keyed under BOTH filename forms vite-plugin-svelte can hand the compiler
		expect(src).toContain('m["/app/src/lib/Shell.svelte"] = m["src/lib/Shell.svelte"]');
	});

	it('collects a plain .css import (the profiler.css shared-sheet pattern)', () => {
		const files: Record<string, string> = {
			'/app/src/lib/Shell.svelte': `<script>import './shared.css';</script><div class="shell">x</div>`,
			'/app/src/lib/shared.css': `body { background: #101318; } .btn { color: red; }`
		};
		const src = router_css_module(['/app/src/lib/Shell.svelte'], {
			root: ROOT,
			lib_dir: LIB,
			is_dev: true,
			read_file: read(files)
		});
		// The imported stylesheet is inlined verbatim (global vocabulary — unscoped).
		expect(src).toContain('background: #101318');
		expect(src).toContain('.btn');
		expect(src).not.toContain('.svelte-'); // a plain sheet carries no scope hash
	});

	it('keys are stable and posix', () => {
		expect(router_css_key(ROOT, '/app/src/lib/Shell.svelte')).toBe('rcss:src/lib/Shell.svelte');
	});
});

describe('runtime registry', () => {
	it('registers by identity, resolves via the thunk, tolerates a throwing thunk', () => {
		const A = function A() {};
		const B = function B() {};
		register_router_css(A, () => [{ key: 'k1', href: '/x.css' }]);
		register_router_css(B, () => {
			throw new Error('broken handoff');
		});
		expect(router_css_of(A)).toEqual([{ key: 'k1', href: '/x.css' }]);
		expect(router_css_of(B)).toEqual([]); // degrade to unstyled, never crash the render
		expect(router_css_of(function C() {})).toEqual([]); // unregistered
		expect(router_css_of(null)).toEqual([]);
	});

	it('dev path registration resolves through svelte dev FILENAME symbol (no component import)', () => {
		register_router_css_paths({
			'/app/src/lib/rtr/Shell.svelte': [{ key: 'rcss-dev:src/lib/rtr/Shell.svelte', css: '.x{}' }]
		});
		// A dev-compiled Svelte 5 component carries `Comp[Symbol(filename)] = '<abs path>'`.
		const Comp = function Shell() {};
		(Comp as unknown as Record<symbol, string>)[Symbol('filename')] =
			'/app/src/lib/rtr/Shell.svelte';
		expect(router_css_of(Comp)).toEqual([
			{ key: 'rcss-dev:src/lib/rtr/Shell.svelte', css: '.x{}' }
		]);
		// An unregistered path resolves to nothing.
		const Other = function Other() {};
		(Other as unknown as Record<symbol, string>)[Symbol('filename')] = '/app/src/lib/Nope.svelte';
		expect(router_css_of(Other)).toEqual([]);
	});
});
