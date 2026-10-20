import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load_kit_dirs } from '../src/vite/kit-dirs.js';
import { kit_dirs, set_kit_dirs, keep_client_dir, KEEP_CLIENT_DIR } from '../src/compiler/kit.js';
import { islandDepsHandoffPath, island_deps_module } from '../src/compiler/link/island-deps.js';

// ─────────────────────────────────────────────────────────────────────────────
// ogygia must follow the app's `kit.files.routes` and `kit.outDir`, not assume `src/routes` and
// `.svelte-kit`. Regression: an app that builds a second route tree from the same source
// (`PES_MODE=v2` → `files.routes: 'src/routes-v2'`, `outDir: '.svelte-kit-v2'`) had its all-csr=false
// tree read as "no routes here" — no keepalive, Kit skipped its client build, the runtime chunk was
// never emitted and every island 404'd; its deps handoff landed in the OTHER tree's `.svelte-kit`.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'og-kit-dirs-')));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

describe('files.routes / outDir / files.hooks', () => {
	const setup = (options: object) => ({ name: 'vite-plugin-sveltekit-setup', api: { options } });
	const defaults = (root: string) => ({
		routes_dir: join(root, 'src/routes'),
		out_dir: join(root, '.svelte-kit'),
		hooks_universal: join(root, 'src/hooks'),
		hooks_client: join(root, 'src/hooks.client')
	});

	it("reads them off Kit's own plugin and resolves them against the root", async () => {
		const root = app({});
		// `sveltekit({ … })` is a promise of plugins, nested anywhere in the list
		const plugins = [{ name: 'ogygia' }, Promise.resolve([{ name: 'vite-plugin-svelte:config' }, setup({ files: { routes: 'src/routes-v2', hooks: { universal: 'app/hooks', client: 'app/client-hooks' } }, outDir: '.svelte-kit-v2', inlineStyleThreshold: 2048 })])];
		const d = await load_kit_dirs(root, plugins);
		expect(d).toEqual({
			routes_dir: join(root, 'src/routes-v2'),
			out_dir: join(root, '.svelte-kit-v2'),
			hooks_universal: join(root, 'app/hooks'),
			hooks_client: join(root, 'app/client-hooks')
		});
		// cached for the compiler (sync) …
		expect(kit_dirs(root)).toEqual(d);
		// … and every path-derived helper follows it
		expect(keep_client_dir(root)).toBe(join(root, 'src/routes-v2', KEEP_CLIENT_DIR));
		expect(islandDepsHandoffPath(d.out_dir)).toBe(join(root, '.svelte-kit-v2/og-region-deps.json'));
	});

	it('defaults to src/routes + .svelte-kit without Kit, or with a Kit config that sets neither', async () => {
		const bare = app({});
		expect(await load_kit_dirs(bare)).toEqual(defaults(bare));
		expect(await load_kit_dirs(bare, [{ name: 'other' }, null, false])).toEqual(defaults(bare));
		expect(await load_kit_dirs(bare, [setup({})])).toEqual(defaults(bare));
	});

	it('an unread root answers the defaults (never throws), a set root answers what was set', () => {
		const root = app({});
		expect(kit_dirs(root)).toEqual(defaults(root));
		set_kit_dirs(root, { ...defaults(root), routes_dir: join(root, 'r'), out_dir: join(root, 'o') });
		expect(kit_dirs(root).routes_dir).toBe(join(root, 'r'));
	});

	it('the SSR deps reader falls back to the configured outDir under cwd, not `.svelte-kit`', () => {
		const src = island_deps_module(true, false, '.svelte-kit-v2');
		expect(src).toContain(`path.join(cwd, ".svelte-kit-v2", 'og-region-deps.json')`);
		expect(src).not.toContain(`'.svelte-kit'`);
		// the default stays the default
		expect(island_deps_module(true, false)).toContain(`path.join(cwd, ".svelte-kit", 'og-region-deps.json')`);
	});
});
