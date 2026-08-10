#!/usr/bin/env node
// Build every framework app for ogygiaBench.
// Packs ogygia from this repo (published shape), syncs shared Counter/posts, installs, builds.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, '..');
const OGY = join(REPO, 'packages', 'ogygia');
const TARBALLS = join(ROOT, '.tarballs');

const run = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

// pnpm exits non-zero on unapproved native build scripts (esbuild/workerd) and refuses to purge a
// stale node_modules without a TTY — neither of which actually breaks the install. Run it CI-mode and
// verify by PRESENCE (node_modules/.modules.yaml) rather than exit code.
const pnpmInstall = (cwd, env) => {
	spawnSync('pnpm', ['install', '--ignore-workspace', '--no-lockfile', '--config.confirmModulesPurge=false'], {
		stdio: 'inherit',
		cwd,
		env: { ...env, CI: '1' }
	});
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
	run('pnpm', ['--filter', 'ogygia', 'build'], { cwd: REPO });
} else if (existsSync(join(OGY, 'dist', 'index.js'))) {
	console.log('  using prebuilt dist (skip standalone rebuild)');
} else {
	pnpmInstall(OGY, process.env);
	run('pnpm', ['run', 'build'], { cwd: OGY });
}
rmSync(TARBALLS, { recursive: true, force: true });
mkdirSync(TARBALLS, { recursive: true });
const pack = spawnSync('pnpm', ['pack', '--pack-destination', TARBALLS], {
	cwd: OGY,
	encoding: 'utf8'
});
if (pack.status !== 0) throw new Error('ogygia pack failed');
const tgzLine = pack.stdout.trim().split('\n').pop().trim();
const tarball = tgzLine.startsWith('/') ? tgzLine : join(TARBALLS, tgzLine.split('/').pop());
console.log(`  packed → ${tarball}`);

const ogygiaApp = join(ROOT, 'frameworks', 'ogygia');
const pkg = JSON.parse(readFileSync(join(ogygiaApp, 'package.json'), 'utf8'));
pkg.dependencies.ogygia = `file:${tarball}`;
writeFileSync(join(ogygiaApp, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');

function installAndBuild(name, { bun = false } = {}) {
	const cwd = join(ROOT, 'frameworks', name);
	console.log(`\n▸ ${name}`);
	run('node', [join(ROOT, 'shared', 'sync.ts'), name]);
	const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
	if (bun) {
		run('bun', ['install'], { cwd, env });
		run('bun', ['run', 'build'], { cwd, env });
	} else {
		pnpmInstall(cwd, env);
		run('pnpm', ['run', 'build'], { cwd, env });
	}
}

installAndBuild('ogygia');
installAndBuild('sveltekit');
installAndBuild('astro');
installAndBuild('mochi', { bun: true });

console.log('\n✓ all frameworks built');
