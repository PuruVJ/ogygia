/**
 * EVERY NAME KIT READS FROM A MODULE OGYGIA STANDS IN FOR, OGYGIA EXPORTS — on every Kit major the
 * package supports. ogygia swaps a few Kit modules for its own in the island client graph: the
 * `$app/*` shims (APP_SHIMS) for island code, and the remote-functions stubs (client.js, its page
 * state, its paths) for Kit's own remote-functions modules. A name the stand-in lacks fails the
 * production build (`MISSING_EXPORT`) — Kit 3's remote `form()` imports `refreshAll`, and every
 * Kit 3 build broke on it. This reads what each Kit actually imports/exports, so a new Kit release
 * that reaches for a new name fails here first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// (Kit 3 lives in its own workspace importer, internal/kit-sources: its svelte ^5.57 peer would
// otherwise move the svelte ogygia resolves, and a dev server ran two Svelte runtimes)
const kit_sources = createRequire(
	path.join(__dirname, '../../../internal/kit-sources/package.json')
);
const KITS = {
	'Kit 2': path.dirname(require.resolve('@sveltejs/kit/package.json')),
	'Kit 3': path.dirname(kit_sources.resolve('@sveltejs/kit3/package.json'))
};

const IMPORT_G = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const EXPORT_LIST_G = /export\s*\{([^}]*)\}/g;
const EXPORT_DECL_G =
	/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;

function names(list: string, side: 'local' | 'exported'): string[] {
	return list
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			const [local, exported] = s.split(/\s+as\s+/);
			return side === 'exported' ? (exported ?? local) : local;
		});
}

function files(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
	});
}

/** What Kit's remote-functions modules import from each module ogygia swaps for a stub. */
function remote_imports(kit: string): Map<string, Set<string>> {
	const client = path.join(kit, 'src/runtime/client');
	const out = new Map<string, Set<string>>();
	for (const file of files(path.join(client, 'remote-functions'))) {
		for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT_G)) {
			const spec = m[2];
			let key: string | null = null;
			if (spec.startsWith('#app/')) key = spec;
			else if (spec.startsWith('.')) {
				const rel = path.relative(client, path.resolve(path.dirname(file), spec));
				if (rel === 'client.js' || rel === 'state.svelte.js') key = rel;
			}
			if (!key) continue;
			const set = out.get(key) ?? new Set();
			for (const n of names(m[1], 'local')) set.add(n);
			out.set(key, set);
		}
	}
	return out;
}

/** Every name a module exports (re-exports followed one level for `export *`). */
function exports_of(file: string): Set<string> {
	const src = fs.readFileSync(file, 'utf8');
	const out = new Set<string>();
	for (const m of src.matchAll(EXPORT_LIST_G)) {
		if (/^\s*type\b/.test(m[1])) continue;
		for (const n of names(m[1].replace(/\btype\s+/g, ''), 'exported')) out.add(n);
	}
	for (const m of src.matchAll(EXPORT_DECL_G)) out.add(m[1]);
	return out;
}

/** Kit's public `$app/<name>` exports, browser condition (Kit 3 moved them under folders + `#app`). */
function kit_app_exports(kit: string, name: string): Set<string> {
	const app = path.join(kit, 'src/runtime/app');
	const entry = fs.existsSync(path.join(app, `${name}.js`))
		? path.join(app, `${name}.js`)
		: path.join(app, name, 'index.js');
	const out = exports_of(entry);
	// `export * from '#app/<name>'` → the package import's browser target
	if (fs.readFileSync(entry, 'utf8').includes(`export * from '#app/${name}'`)) {
		const pkg = JSON.parse(fs.readFileSync(path.join(kit, 'package.json'), 'utf8'));
		const target = pkg.imports?.[`#app/${name}`]?.browser;
		if (target) for (const n of exports_of(path.join(kit, target))) out.add(n);
	}
	return out;
}

const SRC = path.join(__dirname, '../src');
const STUBS: Record<string, string> = {
	'client.js': 'shims/kit-remote/client-stub.ts',
	'state.svelte.js': 'shims/kit-remote/state-stub.ts',
	'#app/state/client': 'shims/kit-remote/state-stub.ts',
	'#app/paths': 'shims/kit-remote/paths-internal-stub.ts'
};
const APP_SHIMS: Record<string, string> = {
	navigation: 'shims/app-navigation.ts',
	state: 'shims/app-state.svelte.ts',
	stores: 'shims/app-stores.ts'
};

/** Names a stub file exports, following its `export … from` one level into other src files. */
function stub_exports(rel: string): Set<string> {
	return exports_of(path.join(SRC, rel));
}

describe.each(Object.entries(KITS))('%s', (_, kit) => {
	const imports = remote_imports(kit);

	it('the scan finds the remote-functions client imports (not vacuous)', () => {
		expect(imports.get('client.js')?.size ?? 0).toBeGreaterThan(3);
	});

	for (const [spec, stub] of Object.entries(STUBS)) {
		it(`the ${spec} stand-in exports every name Kit's remote functions import from it`, () => {
			const wanted = [...(imports.get(spec) ?? [])];
			const have = stub_exports(stub);
			expect(wanted.filter((n) => !have.has(n))).toEqual([]);
		});
	}

	for (const [name, shim] of Object.entries(APP_SHIMS)) {
		it(`the $app/${name} shim exports every name Kit's $app/${name} does`, () => {
			const kit_names = kit_app_exports(kit, name);
			expect(kit_names.size).toBeGreaterThan(0);
			const have = stub_exports(shim);
			expect([...kit_names].filter((n) => !have.has(n)).sort()).toEqual([]);
		});
	}
});
