#!/usr/bin/env node
// Build every framework app for ogygiaBench.
// Packs ogygia from this repo (published shape), syncs shared Counter/posts, installs, builds.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Repo root holds the pnpm workspace + packages/ogygia (the package apps install, a thin layer over
// packages/core = `@ogygia/core`). This script lives at <root>/internal/bench, so the root is two
// levels up. (The hermetic Docker image copies a self-contained tree; there the prebuilt-dist branch
// below is what runs, so this path only matters for a local `pnpm bench`.)
const REPO = join(ROOT, '..', '..');
const OGY = join(REPO, 'packages', 'ogygia');
const CORE = join(REPO, 'packages', 'core');
const CONTENT = join(REPO, 'packages', 'content');
const TARBALLS = join(ROOT, '.tarballs');

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

// pnpm exits non-zero on unapproved native build scripts (esbuild/workerd) and refuses to purge a
// stale node_modules without a TTY — neither of which actually breaks the install. Run it CI-mode and
// verify by PRESENCE (node_modules/.modules.yaml) rather than exit code. `own_workspace`: the app has
// its own pnpm-workspace.yaml (the ogygia app's `@ogygia/core` override), which `--ignore-workspace`
// would skip; it is the nearest one, so the install still never reaches the repo's workspace.
const pnpmInstall = (cwd, env, own_workspace = false) => {
	spawnSync(
		'pnpm',
		[
			'install',
			...(own_workspace ? [] : ['--ignore-workspace']),
			'--no-lockfile',
			'--config.confirmModulesPurge=false'
		],
		{
			stdio: 'inherit',
			cwd,
			env: { ...env, CI: '1' }
		}
	);
	if (!existsSync(join(cwd, 'node_modules', '.modules.yaml')))
		throw new Error(`pnpm install produced no node_modules in ${cwd}`);
};

console.log('▸ generate posts');
run('node', [join(ROOT, 'generate-posts.ts')]);

console.log('▸ build + pack ogygia');
// Prefer monorepo filter (has hoisted build deps). Else, if a prebuilt dist is already present
// (the hermetic image copies it in — building ogygia standalone needs tsdown's whole toolchain,
// which isn't worth reinstalling), pack that. Only as a last resort install + build standalone.
if (existsSync(join(REPO, 'pnpm-workspace.yaml')) && existsSync(join(REPO, 'node_modules'))) {
	run('pnpm', ['--filter', 'ogygia...', '--filter', '@ogygia/content', 'build'], { cwd: REPO });
} else if (
	existsSync(join(OGY, 'dist', 'index.js')) &&
	existsSync(join(CORE, 'dist', 'index.js')) &&
	existsSync(join(CONTENT, 'dist', 'vite', 'index.js'))
) {
	console.log('  using prebuilt dist (skip standalone rebuild)');
} else {
	pnpmInstall(CORE, process.env);
	run('pnpm', ['run', 'build'], { cwd: CORE });
	pnpmInstall(OGY, process.env);
	run('pnpm', ['run', 'build'], { cwd: OGY });
	pnpmInstall(CONTENT, process.env);
	run('pnpm', ['run', 'build'], { cwd: CONTENT });
}
rmSync(TARBALLS, { recursive: true, force: true });
mkdirSync(TARBALLS, { recursive: true });
// The bench app takes ogygia (with the core it re-exports) and its content package (markdown posts),
// all packed, published shape.
const packTo = (cwd, name) => {
	const pack = spawnSync('pnpm', ['pack', '--pack-destination', TARBALLS], {
		cwd,
		encoding: 'utf8'
	});
	if (pack.status !== 0) throw new Error(`${name} pack failed`);
	const tgzLine = pack.stdout.trim().split('\n').pop().trim();
	const tarball = tgzLine.startsWith('/') ? tgzLine : join(TARBALLS, tgzLine.split('/').pop());
	console.log(`  packed → ${tarball}`);
	return tarball;
};
const tarball = packTo(OGY, 'ogygia');
const coreTarball = packTo(CORE, '@ogygia/core');
const contentTarball = packTo(CONTENT, '@ogygia/content');

const ogygiaApp = join(ROOT, 'frameworks', 'ogygia');
const pkg = JSON.parse(readFileSync(join(ogygiaApp, 'package.json'), 'utf8'));
pkg.dependencies.ogygia = `file:${tarball}`;
pkg.dependencies['@ogygia/core'] = `file:${coreTarball}`;
pkg.dependencies['@ogygia/content'] = `file:${contentTarball}`;
writeFileSync(join(ogygiaApp, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');
// `ogygia` and `@ogygia/content` ask for `@ogygia/core` by version (the registry may not have it yet):
// the app's own workspace file points every one of them at the tarball (gitignored, rewritten each run)
writeFileSync(
	join(ogygiaApp, 'pnpm-workspace.yaml'),
	`overrides:\n  '@ogygia/core': 'file:${coreTarball}'\n`
);

function installAndBuild(name, { bun = false } = {}) {
	const cwd = join(ROOT, 'frameworks', name);
	console.log(`\n▸ ${name}`);
	run('node', [join(ROOT, 'shared', 'sync.ts'), name]);
	const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
	if (bun) {
		run('bun', ['install'], { cwd, env });
		run('bun', ['run', 'build'], { cwd, env });
	} else {
		pnpmInstall(cwd, env, existsSync(join(cwd, 'pnpm-workspace.yaml')));
		run('pnpm', ['run', 'build'], { cwd, env });
	}
}

installAndBuild('ogygia');
installAndBuild('sveltekit');
installAndBuild('astro');
installAndBuild('mochi', { bun: true });

console.log('\n✓ all frameworks built');
