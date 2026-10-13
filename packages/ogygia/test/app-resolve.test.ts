// The compiler's ONE app resolver: every sync graph walk asks it which file an import names, so the
// rules here are the rules every walk follows — Vite's order: relative, the app's aliases, `#…`
// subpath imports (the importer's nearest package.json), then extension probing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app_spec_path, app_file, probe_file, clear_app_resolve_cache } from '../src/compiler/app-resolve.js';

let root = '';
const files: Record<string, string> = {
	'package.json': JSON.stringify({
		name: 'app',
		imports: {
			'#lib': './src/lib',
			'#lib/*': './src/lib/*',
			'#lib/legacy/*': null,
			'#cfg': { node: './src/config.server.ts', default: './src/config.ts' },
			'#ui/*.svelte': './src/ui/*.svelte',
			'#dep': 'some-package'
		}
	}),
	'src/lib/Card.svelte': '',
	'src/lib/util.ts': '',
	'src/lib/store.svelte.ts': '',
	'src/lib/index.ts': '',
	'src/lib/nested/index.js': '',
	'src/config.server.ts': '',
	'src/ui/Button.svelte': '',
	'src/boot/read.ts': '',
	'src/routes/+page.svelte': '',
	// a workspace package inside the app with its OWN imports map: its `#lib` is its own
	'packages/ui/package.json': JSON.stringify({ name: 'ui', imports: { '#lib/*': './lib/*' } }),
	'packages/ui/lib/Chip.svelte': '',
	'packages/ui/src/index.ts': ''
};
const at = (rel: string) => path.join(root, rel);

beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'og-app-resolve-')));
	for (const [rel, src] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
		fs.writeFileSync(at(rel), src);
	}
	clear_app_resolve_cache();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('app_spec_path — where an import points', () => {
	const page = () => at('src/routes/+page.svelte');

	it('relative, against the importer', () => {
		expect(app_spec_path('../lib/Card.svelte', page())).toBe(at('src/lib/Card.svelte'));
	});

	it("Kit's #lib, through the package.json imports map", () => {
		expect(app_spec_path('#lib/Card.svelte', page())).toBe(at('src/lib/Card.svelte'));
		expect(app_spec_path('#lib', page())).toBe(at('src/lib'));
	});

	it('the longest matching pattern wins; a null target excludes', () => {
		expect(app_spec_path('#lib/legacy/Old.svelte', page())).toBeNull();
		expect(app_spec_path('#ui/Button.svelte', page())).toBe(at('src/ui/Button.svelte'));
	});

	it('a conditions object takes its first supported condition', () => {
		expect(app_spec_path('#cfg', page())).toBe(at('src/config.server.ts'));
	});

	it('a bare package target, an undeclared #key and a package are not app source', () => {
		expect(app_spec_path('#dep', page())).toBeNull();
		expect(app_spec_path('#nope/x', page())).toBeNull();
		expect(app_spec_path('svelte', page())).toBeNull();
	});

	it("the importer's own package scope decides: a workspace package's #lib is its own", () => {
		expect(app_spec_path('#lib/Chip.svelte', at('packages/ui/src/index.ts'))).toBe(at('packages/ui/lib/Chip.svelte'));
	});

	it("the app's aliases — string (Kit's `alias` shape) and RegExp — before #imports", () => {
		const alias = [
			{ find: '$boot', replacement: at('src/boot') },
			{ find: /^~ui\/(.+)$/, replacement: at('src/ui') + '/$1' }
		];
		expect(app_spec_path('$boot/read', page(), alias)).toBe(at('src/boot/read'));
		expect(app_spec_path('~ui/Button.svelte', page(), alias)).toBe(at('src/ui/Button.svelte'));
	});
});

describe('app_file / probe_file — the file behind it', () => {
	const page = () => at('src/routes/+page.svelte');

	it('an exact file, an added extension, a .svelte.ts module, an index', () => {
		expect(app_file('#lib/Card.svelte', page())).toBe(at('src/lib/Card.svelte'));
		expect(app_file('#lib/util', page())).toBe(at('src/lib/util.ts'));
		expect(app_file('#lib/store.svelte', page())).toBe(at('src/lib/store.svelte.ts'));
		expect(app_file('#lib', page())).toBe(at('src/lib/index.ts'));
		expect(app_file('#lib/nested', page())).toBe(at('src/lib/nested/index.js'));
	});

	it("a TypeScript source's `.js` names its `.ts` sibling", () => {
		expect(app_file('#lib/util.js', page())).toBe(at('src/lib/util.ts'));
	});

	it('null for a package and for a missing file', () => {
		expect(app_file('svelte', page())).toBeNull();
		expect(app_file('#lib/Missing.svelte', page())).toBeNull();
	});

	it('a virtual filesystem can stand in (the compiler host in a test or the browser)', () => {
		const vfs = new Set(['/v/src/a.ts']);
		expect(probe_file('/v/src/a', { is_file: (p) => vfs.has(p) })).toBe('/v/src/a.ts');
	});
});
