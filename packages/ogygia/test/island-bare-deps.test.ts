// REGRESSION (field report #5): the dev reload storm. Under `csr = false` Kit ships no client entry,
// so Vite's dep scanner sees an empty client graph and island deps are discovered LAZILY, one wake
// at a time — each discovery re-optimizes, rotates the browserHash and full-reloads. The islands ARE
// the client graph; `island_bare_deps()` walks every hydrate island's closure and returns the bare
// package specifiers Vite must pre-bundle at server start, so nothing is left to discover.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

let root = '';

const files: Record<string, string> = {
	'src/routes/+layout.ts': 'export const csr = false;\n',
	// A hydrate island, a lake, and a server (defer) island — only the FIRST is client code.
	'src/routes/+page.svelte':
		`<script>\n` +
		`\timport Widget from '$lib/Widget.svelte' with { wake: 'visible' };\n` +
		`\timport Frozen from '$lib/Frozen.svelte' with { wake: 'none' };\n` +
		`\timport Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };\n` +
		`</script>\n<Widget /><Frozen /><Greeting />\n`,
	// static import of a bare package + a relative helper + an alias-reached module
	'src/lib/Widget.svelte':
		`<script>\n` +
		`\timport { track } from 'analytics-sdk';\n` +
		`\timport { fmt } from './fmt';\n` +
		`\timport { boot } from '$boot/boot';\n` +
		`\timport { iso } from './iso';\n` +
		`\timport { page } from '$app/state';\n` +
		`\timport 'virtual:ogygia/transportables';\n` +
		`</script>\n<p>{fmt(track(page.data.x))}{boot()}{iso()}</p>\n`,
	// plugin-resolved QUERY imports (vite-plugin-iso-import's `?client`, Vite's `?raw`) and a package
	// subpath import (`#internal`) — plugin / package territory the dep optimizer cannot open as a file
	'src/lib/iso.ts':
		`import Ctl from '@pes-ui/components/dist/controller?client';\n` +
		`import txt from 'some-pkg/readme.md?raw';\n` +
		`import { z } from '#internal';\n` +
		`export const iso = () => Ctl + txt + z;\n`,
	// a helper with a side-effect import AND a deep import of a scoped package
	'src/lib/fmt.ts': `import 'polyfill-lib';\nimport { f } from '@scope/utils/deep';\nexport const fmt = (v) => f(v);\n`,
	// reached only through the alias; carries a LAZY dynamic import — the discovery driver
	'src/lib/boot/boot.ts': `export const boot = () => import('lazy-chart').then((m) => m.draw());\n`,
	// a lake: frozen HTML, no client JS — its dep must NOT be pre-bundled
	'src/lib/Frozen.svelte': `<script>\n\timport { heavy } from 'lake-only-dep';\n</script>\n<p>{heavy()}</p>\n`,
	// a server island: renders on the server — its dep is NOT client code
	'src/lib/Greeting.svelte': `<script>\n\timport { db } from 'server-only-db';\n</script>\n<p>{db()}</p>\n`
};

function make_compiler() {
	const program = new Program({ forms: true, router: true });
	const profiler = {
		prof: {
			transformMs: 0,
			transformN: 0,
			transformHit: 0,
			prescanMs: 0,
			bakeMs: 0,
			bakeN: 0,
			resolveMs: 0,
			loadMs: 0
		},
		P: false,
		outHash: new Map<string, number>()
	};
	const compiler = new Compiler(program, profiler);
	compiler.configure(
		new CompileCtx({
			root,
			base: '/',
			libDir: path.join(root, 'src/lib'),
			is_dev: true,
			id_salt: '',
			visibleMargin: '0px',
			presets: {},
			import_keys: normalize_import_keys(undefined),
			resolve_alias: [{ find: '$boot', replacement: path.join(root, 'src/lib/boot') }],
			markdown_config: null,
			pkg_root: '/nowhere/ogygia',
			app_shims: {
				'$app/state': '/nowhere/ogygia/shims/app-state.svelte.js',
				'$app/stores': '/nowhere/ogygia/shims/app-stores.js',
				'$app/navigation': '/nowhere/ogygia/shims/app-navigation.js'
			}
		})
	);
	return { compiler, program };
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bare-deps-'));
	for (const [rel, src] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, src);
	}
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('island_bare_deps — the client dep graph Vite cannot see', () => {
	test('collects every bare package a hydrate island can reach: static, side-effect, deep, and dynamic', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const deps = compiler.island_bare_deps();
		expect(deps).toContain('analytics-sdk'); // static, in the island itself
		expect(deps).toContain('polyfill-lib'); // side-effect import, via a relative helper
		expect(deps).toContain('@scope/utils/deep'); // a deep import keeps its full specifier
		expect(deps).toContain('lazy-chart'); // dynamic import(), reached through an app alias
	});

	test('leaves out what is not client code or not a prebundle target', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const deps = compiler.island_bare_deps();
		expect(deps).not.toContain('lake-only-dep'); // a lake ships no client JS
		expect(deps).not.toContain('server-only-db'); // a defer island renders on the server
		expect(deps.some((d) => d.startsWith('$app/'))).toBe(false); // Kit virtual
		expect(deps.some((d) => d.startsWith('virtual:'))).toBe(false); // plugin virtual
	});

	// REGRESSION (field report #5, follow-up): seeding a bare specifier WITH its plugin query
	// (`…/controller?client`) made rolldown try to open `controller.js?client` from disk →
	// UNLOADABLE_DEPENDENCY, a dead dev server. Query and subpath imports are plugin territory.
	test('never seeds a plugin-query or package-subpath import — those resolve through the plugin pipeline', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const deps = compiler.island_bare_deps();
		expect(deps.some((d) => d.includes('?'))).toBe(false); // no `?client` / `?raw` ever
		expect(deps).not.toContain('@pes-ui/components/dist/controller'); // nor the query stripped off
		expect(deps).not.toContain('some-pkg/readme.md');
		expect(deps.some((d) => d.startsWith('#'))).toBe(false); // no `#internal`
		// the module that carried them was still walked — its sibling bare deps are unaffected
		expect(deps).toContain('analytics-sdk');
	});

	test('is sorted and free of duplicates, so the optimizer config is stable run to run', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const deps = compiler.island_bare_deps();
		expect(deps).toEqual([...new Set(deps)].sort());
	});
});
