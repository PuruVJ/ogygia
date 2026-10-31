/**
 * Run only the e2e specs a change can break (the rules: e2e/scope.ts).
 *
 *   node e2e/affected.ts                       # vs the merge base with origin/next, plus local edits
 *   node e2e/affected.ts --base origin/main    # another base
 *   node e2e/affected.ts --dry                 # say what would run, and why; run nothing
 *
 * Anything it cannot place runs the whole suite. Extra arguments after `--` go to Playwright.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affected_specs, type Workspace } from './scope.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const passthrough = sep === -1 ? [] : argv.slice(sep + 1);
const base_at = own.indexOf('--base');
const base = base_at !== -1 ? own[base_at + 1] : (process.env.E2E_BASE ?? 'origin/next');
const dry = own.includes('--dry');

// (not trimmed: a porcelain status line starts with a space when only the worktree changed)
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

function changed_files(): string[] {
	const files = new Set<string>();
	const merge_base = git('merge-base', base, 'HEAD').trim();
	for (const f of git('diff', '--name-only', `${merge_base}...HEAD`).split('\n')) if (f) files.add(f);
	// …and what is not committed yet (renames list both sides)
	for (const line of git('status', '--porcelain').split('\n')) {
		if (!line) continue;
		for (const f of line.slice(3).split(' -> ')) files.add(f.replace(/^"|"$/g, ''));
	}
	return [...files];
}

function workspace(): Workspace {
	const names: Record<string, string> = {};
	const deps: Record<string, string[]> = {};
	const dir = path.join(repo, 'packages');
	for (const d of readdirSync(dir)) {
		const file = path.join(dir, d, 'package.json');
		if (!existsSync(file)) continue;
		const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
			name: string;
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		names[d] = pkg.name;
		deps[pkg.name] = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
	}
	return { names, deps };
}

const result = affected_specs(changed_files(), workspace());
if (result.all) {
	console.log(`e2e: the whole suite (${result.why.join(', ')})`);
} else if (!result.specs.length) {
	console.log('e2e: nothing to run — no change an e2e spec can see');
	process.exit(0);
} else {
	console.log(`e2e: ${result.specs.length} spec(s)\n  ${result.why.join('\n  ')}`);
}
if (dry) process.exit(0);

const run = spawnSync('pnpm', ['exec', 'playwright', 'test', ...(result.all ? [] : result.specs), ...passthrough], {
	cwd: repo,
	stdio: 'inherit'
});
process.exit(run.status ?? 1);
