// `pnpm run release` (the release workflow's publish step, after the Version packages PR merged):
// publish `ogygia` at its package.json version unless npm has it, then make sure its `v<version>` tag
// and GitHub release exist. Idempotent: every step checks first, so a re-run finishes what a failed
// run left.
//
// Packed with pnpm (only `pnpm pack` applies `publishConfig`, which swaps the dev `exports` pointing at
// `src/` for the `dist/` map), published with npm (trusted publishing: the workflow's OIDC token, no
// npm token stored anywhere).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG_DIR = 'packages/ogygia';
const CHANGELOG = `${PKG_DIR}/CHANGELOG.md`;
const { name, version } = JSON.parse(fs.readFileSync(`${PKG_DIR}/package.json`, 'utf8'));
const tag = `v${version}`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const ok = (cmd, args) => {
	try {
		execFileSync(cmd, args, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

// 1. npm
if (ok('npm', ['view', `${name}@${version}`, 'version'])) {
	console.log(`${name}@${version} is already on npm`);
} else {
	run('pnpm', ['run', 'build:lib']);
	run('pnpm', ['--filter', name, 'run', 'verify:package']);
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ogygia-pack-'));
	run('pnpm', ['pack', '--pack-destination', out], { cwd: PKG_DIR });
	const tarball = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
	if (!tarball) throw new Error(`pnpm pack wrote no tarball to ${out}`);
	run('npm', ['publish', path.join(out, tarball), '--access', 'public', '--provenance']);
	console.log(`published ${name}@${version}`);
}

// 2. the tag, on the commit being released
if (ok('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])) {
	console.log(`${tag} already exists`);
} else {
	run('git', ['tag', '-a', tag, '-m', tag]);
	run('git', ['push', 'origin', tag]);
}

// 3. the GitHub release, its notes the changelog's section for this version
if (ok('gh', ['release', 'view', tag])) {
	console.log(`release ${tag} already exists`);
} else {
	const lines = fs.readFileSync(CHANGELOG, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
	if (start === -1) throw new Error(`${CHANGELOG} has no "## [${version}]" section`);
	let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
	if (end === -1) end = lines.length;
	const notes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ogygia-notes-')), 'notes.md');
	fs.writeFileSync(notes, lines.slice(start + 1, end).join('\n').trim() + '\n');
	run('gh', ['release', 'create', tag, '--title', tag, '--notes-file', notes]);
}
