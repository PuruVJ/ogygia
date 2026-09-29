// DEV WITH AN INSTALLED OGYGIA — the package as a user gets it (packed, unpacked into the app's
// node_modules: a real directory, not a workspace link), served by Vite's dev server.
//
//   pnpm exec playwright test dev-installed
//
// The regression (field report, 2026-09-29): Vite pre-bundled the installed package's
// `ogygia/runtime` (the dev boot) into `.vite/deps`, while everything the compiler writes — the
// island modules and their `ogygia/internal`, `virtual:ogygia/hydrate-features` — imports ogygia's
// files by path. The page ran two copies of ogygia's stateful modules: the wire feature installed
// into one `slots`, the hydrate core read the other, and every island with a snippet prop failed
// ("wired prop but no wire feature in this build"). A workspace-linked ogygia is never pre-bundled,
// which is why no other suite could see it. ogygia now keeps itself out of the dep optimizer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, check } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const pkg = path.join(repo, 'packages', 'ogygia');
const PORT = 3094;
const base = `http://127.0.0.1:${PORT}`;

let app = '';
let srv: SpawnedServer | null = null;

/** The real directory of a package the repo already has (the app links to it, as an install would place it). */
function real(name: string): string {
	for (const dir of [path.join(pkg, 'node_modules'), path.join(repo, 'apps', 'playground', 'node_modules'), path.join(repo, 'node_modules')]) {
		const p = path.join(dir, name);
		if (fs.existsSync(p)) return fs.realpathSync(p);
	}
	throw new Error(`no ${name} in the repo`);
}

const FILES: Record<string, string> = {
	'package.json': '{ "name": "installed-app", "private": true, "type": "module" }\n',
	'svelte.config.js': "import { ogygia } from 'ogygia/vite';\nexport default { extensions: ogygia.extensions(), preprocess: [...ogygia.preprocess()], kit: {} };\n",
	'vite.config.js': "import { sveltekit } from '@sveltejs/kit/vite';\nimport { ogygia } from 'ogygia/vite';\nexport default { plugins: [ogygia(), sveltekit()] };\n",
	'src/app.html': '<!doctype html><html><head><meta charset="utf-8" />%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>\n',
	'src/routes/+page.ts': 'export const csr = false;\n',
	// an island with a snippet prop (its children: they cross as a wired value) …
	'src/lib/Card.svelte': `<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	let n = $state(0);
</script>
<div data-card><button data-bump onclick={() => n++}>bump {n}</button>{@render children()}</div>
`,
	// … beside one with plain props (JSON: never went through the wire)
	'src/lib/Plain.svelte': `<script lang="ts">
	let { label }: { label: string } = $props();
	let n = $state(0);
</script>
<button data-plain onclick={() => n++}>{label} {n}</button>
`,
	'src/routes/+page.svelte': `<script lang="ts">
	import Card from '$lib/Card.svelte' with { wake: 'load' };
	import Plain from '$lib/Plain.svelte' with { wake: 'load' };
</script>
<Card><p data-kid>a child from the page</p></Card>
<Plain label="plain" />
`
};

test.describe('dev: an installed (not linked) ogygia runs as one copy in the browser', () => {
	test.beforeAll(async () => {
		test.setTimeout(240_000);
		app = fs.mkdtempSync(path.join(os.tmpdir(), 'ogygia-installed-'));
		for (const [rel, text] of Object.entries(FILES)) {
			fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
			fs.writeFileSync(path.join(app, rel), text);
		}
		// the package exactly as published (publishConfig swaps the exports to dist), unpacked
		const nm = path.join(app, 'node_modules');
		fs.mkdirSync(path.join(nm, 'ogygia'), { recursive: true });
		const tgz = execFileSync('pnpm', ['pack', '--pack-destination', app], { cwd: pkg, encoding: 'utf8' }).trim().split('\n').at(-1)!;
		execFileSync('tar', ['-xzf', path.isAbsolute(tgz) ? tgz : path.join(app, path.basename(tgz)), '-C', path.join(nm, 'ogygia'), '--strip-components=1']);
		for (const dep of ['svelte', '@sveltejs', 'vite', 'devalue', 'esm-env', 'estree-walker', 'magic-string', 'rolldown', 'tinyglobby'])
			fs.symlinkSync(real(dep), path.join(nm, dep));
		srv = await spawn_server({
			cmd: process.execPath,
			args: [path.join(nm, 'vite', 'bin', 'vite.js'), 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
			cwd: app,
			url: `${base}/`,
			timeout_ms: 120_000
		});
	});

	test.afterAll(() => {
		srv?.kill();
		if (app) fs.rmSync(app, { recursive: true, force: true });
	});

	test('a snippet-prop island hydrates, and no ogygia module is loaded twice', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
		page.on('pageerror', (e) => errors.push(e.message));
		// (the first visit may optimize the app's own deps and reload once: land on a settled page)
		await page.goto(`${base}/`, { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		errors.length = 0;
		await page.goto(`${base}/`, { waitUntil: 'load' });
		await page.waitForFunction(() => document.querySelectorAll('ogygia-region[data-og-hydrated], ogygia-region[hydrated]').length >= 2, null, { timeout: 15_000 }).catch(() => {});
		await page.waitForTimeout(800);
		await page.click('[data-bump]');
		await page.click('[data-plain]');
		check('the snippet-prop island woke (its click works)', (await page.textContent('[data-bump]'))?.trim() === 'bump 1', (await page.textContent('[data-bump]')) ?? '');
		check('its children are the page’s', (await page.locator('[data-card] [data-kid]').count()) === 1);
		check('the plain island woke', (await page.textContent('[data-plain]'))?.trim() === 'plain 1');
		check('no hydration error', !errors.some((e) => e.includes('hydration failed') || e.includes('wired prop')), errors.slice(0, 2).join(' | '));

		// ONE COPY: every ogygia module the browser loaded is ogygia's own file, each once — none
		// from the dep optimizer's bundle (where a second copy of its state would live)
		const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname));
		const own = loaded.filter((p) => p.includes('/node_modules/ogygia/'));
		check('the page loads ogygia’s runtime and its slots from ogygia’s own files', own.some((p) => p.endsWith('/runtime/slots.js')) && own.some((p) => p.endsWith('/runtime/hydrate-core.js')), own.length + ' files');
		check('each ogygia file once', new Set(own).size === own.length, own.filter((p, i) => own.indexOf(p) !== i).join(', '));
		const meta = await (await fetch(`${base}/node_modules/.vite/deps/_metadata.json`)).json().catch(() => null);
		const bundled = Object.entries((meta?.optimized ?? {}) as Record<string, { src?: string }>)
			.filter(([id, m]) => id === 'ogygia' || id.startsWith('ogygia/') || (m.src ?? '').includes('/node_modules/ogygia/'))
			.map(([id]) => id);
		check('the dep optimizer bundled no part of ogygia', !!meta && bundled.length === 0, bundled.join(', '));
		check('…while it still bundles ogygia’s dependencies, shared with the app', !!meta && 'svelte' in (meta.optimized ?? {}), Object.keys(meta?.optimized ?? {}).slice(0, 6).join(', '));
	});
});
