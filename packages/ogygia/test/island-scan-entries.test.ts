// REGRESSION (field report #5, and the two pins that followed it): the dev reload storm. Under
// `csr = false` Kit ships no client entry and registers only `routes/**/+*` as dep-scan entries, so
// an island reached through a registry / glob / `.remote.ts` mint is never crawled — its client deps
// are discovered LAZILY on first wake, each discovery re-optimizing and full-reloading.
//
// `island_scan_entries()` returns every hydrate island's component FILE and host FILE for
// `optimizeDeps.entries`, so Vite's OWN scanner crawls them with the full plugin pipeline. It is
// deliberately not a self-computed `optimizeDeps.include` list: two pins in a row (c4161c2, 351d7eb)
// seeded ids Vite's resolver would have handled — a `?client` plugin query, then a linked workspace
// package whose internals carried one — and rolldown died with UNLOADABLE_DEPENDENCY. An entry can
// only add a crawl root; what the crawl finds is Vite's call, with every plugin's resolveId in play.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

let root = '';

// The bare packages the fixtures import — what the CRAWL would find. None may ever be an entry.
const CRAWL_FINDINGS_RE = /analytics-sdk|chart-lib|lake-only-dep|server-only-db/;

const files: Record<string, string> = {
	'src/routes/+layout.ts': 'export const csr = false;\n',
	// A hydrate island, a lake, and a server (defer) island — only the FIRST is client code.
	'src/routes/+page.svelte':
		`<script>\n` +
		`\timport Widget from '$lib/Widget.svelte' with { wake: 'visible' };\n` +
		`\timport Frozen from '$lib/Frozen.svelte' with { wake: 'none' };\n` +
		`\timport Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };\n` +
		`</script>\n<Widget /><Frozen /><Greeting />\n`,
	'src/lib/Widget.svelte': `<script>\n\timport { track } from 'analytics-sdk';\n</script>\n<p>{track()}</p>\n`,
	'src/lib/Frozen.svelte': `<script>\n\timport { heavy } from 'lake-only-dep';\n</script>\n<p>{heavy()}</p>\n`,
	'src/lib/Greeting.svelte': `<script>\n\timport { db } from 'server-only-db';\n</script>\n<p>{db()}</p>\n`,
	// A second hydrate island placed from a host that is NOT a route file — the registry / glob shape
	// Kit's own `routes/**/+*` entries never reach. Its host lives in a route GROUP directory, whose
	// parentheses are glob syntax to the scanner and must be escaped by the adapter.
	'src/lib/(group)/Host.svelte':
		`<script>\n\timport Chart from './Chart.svelte' with { wake: 'idle' };\n</script>\n<Chart />\n`,
	'src/lib/(group)/Chart.svelte': `<script>\n\timport { draw } from 'chart-lib';\n</script>\n<p>{draw()}</p>\n`
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
			resolve_alias: [],
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
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-scan-entries-'));
	for (const [rel, src] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, src);
	}
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('island_scan_entries — crawl roots for Vite’s own dep scanner', () => {
	test('every hydrate island’s component file AND its host file are entries', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const entries = compiler.island_scan_entries();
		expect(entries).toContain(path.join(root, 'src/lib/Widget.svelte')); // the island
		expect(entries).toContain(path.join(root, 'src/routes/+page.svelte')); // its host
		// the registry-shaped island Kit's route entries would never reach
		expect(entries).toContain(path.join(root, 'src/lib/(group)/Chart.svelte'));
		expect(entries).toContain(path.join(root, 'src/lib/(group)/Host.svelte'));
	});

	test('a lake and a server island are not entries — neither is client code', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const entries = compiler.island_scan_entries();
		expect(entries).not.toContain(path.join(root, 'src/lib/Frozen.svelte')); // wake: 'none'
		expect(entries).not.toContain(path.join(root, 'src/lib/Greeting.svelte')); // render: 'deferred'
	});

	test('entries are real, absolute, existing source files — never a bare package, query or virtual id', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const entries = compiler.island_scan_entries();
		expect(entries.length).toBeGreaterThan(0);
		for (const e of entries) {
			expect(path.isAbsolute(e)).toBe(true);
			expect(fs.statSync(e).isFile()).toBe(true);
			expect(e.includes('?')).toBe(false);
			expect(e.startsWith('virtual:')).toBe(false);
		}
		// nothing the crawl would FIND is ever returned — that is the scanner's job, not ours
		expect(entries.some((e) => CRAWL_FINDINGS_RE.test(e))).toBe(false);
	});

	test('is sorted and free of duplicates, so the optimizer config is stable run to run', () => {
		const { compiler } = make_compiler();
		compiler.prescan();
		const entries = compiler.island_scan_entries();
		expect(entries).toEqual([...new Set(entries)].sort());
	});
});
