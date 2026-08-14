import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Black-box suite for `ogygia pharos init`. It drives the REAL CLI (the source, run by Node's native
// TS support) against throwaway fixture projects on disk, so it exercises argv parsing, the sv-utils
// config codemods, and the file writes exactly as a user would hit them. No install / no build — we
// assert on exit code, stdout, and the files the scaffolder produced.

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const created: string[] = [];
afterEach(() => {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A `sv create`-shaped SvelteKit project: config in `svelte.config.js`, plugin-less `vite.config`. */
function svelteConfigProject(extra: Record<string, string> = {}): string {
	return project({
		'package.json': JSON.stringify({
			name: 'fixture',
			type: 'module',
			devDependencies: { '@sveltejs/kit': '^2.70.0', svelte: '^5.0.0', vite: '^8.0.0' }
		}),
		'svelte.config.js': [
			"import adapter from '@sveltejs/adapter-node';",
			"import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';",
			'',
			'const config = {',
			'\tpreprocess: vitePreprocess(),',
			'\tkit: { adapter: adapter() }',
			'};',
			'',
			'export default config;'
		].join('\n'),
		'vite.config.ts': [
			"import { sveltekit } from '@sveltejs/kit/vite';",
			"import { defineConfig } from 'vite';",
			'',
			'export default defineConfig({ plugins: [sveltekit()] });'
		].join('\n'),
		'tsconfig.json': '{ "extends": "./.svelte-kit/tsconfig.json" }',
		...extra
	});
}

/** A project whose svelte/kit config lives in the `sveltekit({ … })` call in `vite.config`. */
function viteConfigProject(extra: Record<string, string> = {}): string {
	return project({
		'package.json': JSON.stringify({
			name: 'fixture',
			type: 'module',
			devDependencies: { '@sveltejs/kit': '^2.70.0', svelte: '^5.0.0', vite: '^8.0.0' }
		}),
		'vite.config.ts': [
			"import { sveltekit } from '@sveltejs/kit/vite';",
			"import { defineConfig } from 'vite';",
			'',
			'export default defineConfig({ plugins: [sveltekit({ adapter: undefined })] });'
		].join('\n'),
		'tsconfig.json': '{ "extends": "./.svelte-kit/tsconfig.json" }',
		...extra
	});
}

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'pharos-cli-'));
	created.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	return dir;
}

function run(dir: string, args: string[]) {
	const res = spawnSync('node', [CLI, 'pharos', ...args], {
		cwd: dir,
		encoding: 'utf8',
		// non-TTY stdin → confirm() falls to its safe default (never clobbers)
		stdio: ['ignore', 'pipe', 'pipe']
	});
	return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
const has = (dir: string, rel: string) => existsSync(join(dir, rel));

// ── happy path: the sv-create shape ─────────────────────────────────────────
describe('pharos init — svelte.config project', () => {
	it('scaffolds the full site and wires configs correctly', () => {
		const dir = svelteConfigProject();
		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(0);

		// every route + the site + starter content exists
		for (const f of [
			'src/lib/docs.ts',
			'src/content/docs/introduction.svx',
			'src/content/docs/getting-started.svx',
			'src/routes/+layout.svelte',
			'src/routes/+layout.ts',
			'src/routes/+page.svelte',
			'src/routes/+error.svelte',
			'src/routes/[...slug]/+page.ts',
			'src/routes/[...slug]/+page.svelte',
			'src/routes/[...slug].md/+server.ts',
			'src/routes/search.json/+server.ts',
			'src/routes/sitemap.xml/+server.ts',
			'src/routes/llms.txt/+server.ts',
			'src/routes/search/+page.server.ts',
			'src/routes/search/+page.svelte'
		]) {
			expect(has(dir, f), `missing ${f}`).toBe(true);
		}

		// svelte.config: preprocess MERGED (not clobbered), extensions + async added
		const sc = read(dir, 'svelte.config.js');
		expect(sc).toMatch(/preprocess:\s*\[vitePreprocess\(\),\s*\.\.\.ogygia\.preprocess\(\)\]/);
		expect(sc).toMatch(/extensions:\s*ogygia\.extensions\(\)/);
		expect(sc).toMatch(/compilerOptions:[\s\S]*experimental:[\s\S]*async:\s*true/);
		expect(sc).toContain('adapter()'); // the user's adapter survived

		// vite.config: the ogygia() plugin, but NO args added to sveltekit() (that would drop async)
		const vc = read(dir, 'vite.config.ts');
		expect(vc).toMatch(/ogygia\(\{\s*content:\s*\{\s*markdown:/);
		expect(vc).toMatch(/sveltekit\(\)/);

		// the layout mounts Calypso at the root base
		expect(read(dir, 'src/routes/+layout.svelte')).toMatch(/<Calypso \{site\} base="" title="Docs">/);
		// hooks wired
		expect(read(dir, 'src/hooks.server.ts')).toContain('ogygia.handle()');
	});
});

// ── the vite.config (sveltekit({...})) shape ────────────────────────────────
describe('pharos init — vite.config project', () => {
	it('routes svelte options into the sveltekit() call', () => {
		const dir = viteConfigProject();
		const { status } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(0);
		const vc = read(dir, 'vite.config.ts');
		// extensions/preprocess/compilerOptions land inside sveltekit({ … }) here
		expect(vc).toMatch(/extensions:\s*ogygia\.extensions\(\)/);
		expect(vc).toMatch(/ogygia\.preprocess\(\)/);
		expect(vc).toMatch(/async:\s*true/);
	});
});

// ── layout safety ───────────────────────────────────────────────────────────
describe('pharos init — existing layout', () => {
	const CUSTOM = '<script>/* my precious layout */</script>\n<slot />\n';

	it('never clobbers an existing layout without --force (and says why)', () => {
		const dir = svelteConfigProject({ 'src/routes/+layout.svelte': CUSTOM });
		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(1);
		expect(out).toMatch(/already exists/);
		expect(out).toContain('--force');
		// the file is untouched
		expect(read(dir, 'src/routes/+layout.svelte')).toBe(CUSTOM);
	});

	it('overwrites the layout with --force', () => {
		const dir = svelteConfigProject({ 'src/routes/+layout.svelte': CUSTOM });
		const { status } = run(dir, ['init', '--force', '--no-install']);
		expect(status).toBe(0);
		expect(read(dir, 'src/routes/+layout.svelte')).toContain('<Calypso {site}');
	});

	it('recognises an existing pharos shell as redeemable and keeps it (no --force needed)', () => {
		const shell = [
			'<script lang="ts">',
			"\timport { Calypso } from 'ogygia/pharos';",
			"\timport { site } from '$lib/docs';",
			'\tlet { children } = $props();',
			'</script>',
			'',
			'<Calypso {site} base="" title="My Edited Title">{@render children()}</Calypso>'
		].join('\n');
		const dir = svelteConfigProject({ 'src/routes/+layout.svelte': shell });
		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(0);
		expect(out).toMatch(/pharos shell, kept/);
		// the user's edits to their pharos layout survive untouched
		expect(read(dir, 'src/routes/+layout.svelte')).toBe(shell);
	});
});

// ── custom + invalid --layout ────────────────────────────────────────────────
describe('pharos init — --layout', () => {
	it('mounts under a nested layout dir with the right base', () => {
		const dir = svelteConfigProject();
		const { status } = run(dir, [
			'init',
			'--layout',
			'src/routes/docs/+layout.svelte',
			'-y',
			'--no-install'
		]);
		expect(status).toBe(0);
		expect(has(dir, 'src/routes/docs/+layout.svelte')).toBe(true);
		expect(has(dir, 'src/routes/docs/[...slug]/+page.svelte')).toBe(true);
		expect(has(dir, 'src/routes/docs/search.json/+server.ts')).toBe(true);
		expect(read(dir, 'src/routes/docs/+layout.svelte')).toContain('base="/docs"');
		// the emit endpoints carry the base too
		expect(read(dir, 'src/routes/docs/search.json/+server.ts')).toMatch(
			/site\.emit\.search\(\{ base: "\/docs" \}\)/
		);
	});

	it('rejects a --layout outside src/routes', () => {
		const dir = svelteConfigProject();
		const { status, out } = run(dir, ['init', '--layout', 'src/+layout.svelte', '-y', '--no-install']);
		expect(status).toBe(1);
		expect(out).toMatch(/must be a \+layout\.svelte under src\/routes/);
	});

	it('rejects a --layout that is not a +layout.svelte', () => {
		const dir = svelteConfigProject();
		const { status } = run(dir, ['init', '--layout', 'src/routes/+page.svelte', '-y', '--no-install']);
		expect(status).toBe(1);
	});
});

// ── bad invocations ──────────────────────────────────────────────────────────
describe('pharos init — guards', () => {
	it('errors when not a SvelteKit project', () => {
		const dir = project({ 'package.json': JSON.stringify({ name: 'x', type: 'module' }) });
		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(1);
		expect(out).toMatch(/SvelteKit/);
	});

	it('errors when there is no vite config', () => {
		const dir = project({
			'package.json': JSON.stringify({
				name: 'x',
				type: 'module',
				devDependencies: { '@sveltejs/kit': '^2.70.0' }
			})
		});
		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(1);
		expect(out).toMatch(/vite\.config/);
	});

	it('prints usage for `pharos` with no subcommand', () => {
		const dir = svelteConfigProject();
		const res = spawnSync('node', [CLI, 'pharos'], { cwd: dir, encoding: 'utf8' });
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/pharos init/);
	});
});

// ── idempotency + content preservation ───────────────────────────────────────
describe('pharos init — re-runs', () => {
	it('is idempotent: a second run keeps existing files', () => {
		const dir = svelteConfigProject();
		expect(run(dir, ['init', '-y', '--no-install']).status).toBe(0);
		const layoutBefore = read(dir, 'src/routes/+layout.svelte');

		const { status, out } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(0);
		expect(out).toMatch(/kept/); // existing files reported as kept, not rewritten
		expect(read(dir, 'src/routes/+layout.svelte')).toBe(layoutBefore);
	});

	it('keeps the user’s own content instead of writing starter pages', () => {
		const mine = '---\ntitle: Mine\n---\n\n# Mine\n';
		const dir = svelteConfigProject({ 'src/content/docs/mine.svx': mine });
		const { status } = run(dir, ['init', '-y', '--no-install']);
		expect(status).toBe(0);
		expect(has(dir, 'src/content/docs/introduction.svx')).toBe(false); // starter skipped
		expect(read(dir, 'src/content/docs/mine.svx')).toBe(mine); // author page untouched
	});
});
