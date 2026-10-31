// The packed (published-shape) `ogygia` for the suites that install it outside the workspace.
// `ogygia` is a thin package over `@ogygia/core` and depends on it by exact version, which the
// registry may not have yet: the app gets both tarballs, and its own pnpm-workspace.yaml overrides
// `@ogygia/core` with core's tarball, so the install never asks the registry for it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './paths.ts';

/** The `ogygia` package apps install (packages/ogygia) and the core it re-exports (packages/core). */
export const OGYGIA_DIR = join(REPO, 'packages', 'ogygia');
export const CORE_DIR = join(REPO, 'packages', 'core');

export interface PackedOgygia {
	ogygia: string;
	core: string;
}

/** `pnpm pack` one package into `dest`; the tarball's absolute path. */
export function pack(dir: string, dest: string): string {
	const out = spawnSync('pnpm', ['pack', '--pack-destination', dest], {
		cwd: dir,
		encoding: 'utf8'
	});
	if (out.status !== 0) throw new Error(`pnpm pack failed in ${dir}:\n${out.stderr}`);
	const line = out.stdout.trim().split('\n').pop()!.trim();
	return line.startsWith('/') ? line : join(dest, line.split('/').pop()!);
}

/** Pack `ogygia` and `@ogygia/core` (both already built) into `dest`. */
export function pack_ogygia(dest: string): PackedOgygia {
	return { ogygia: pack(OGYGIA_DIR, dest), core: pack(CORE_DIR, dest) };
}

/** Point the app at the packed `ogygia`: its dependency, plus the `@ogygia/core` override in the app's
 *  own pnpm-workspace.yaml (which makes the app its own workspace root: install it WITHOUT
 *  `--ignore-workspace`, or the override is ignored). */
export function use_packed(app: string, packed: PackedOgygia): void {
	const pkg_file = join(app, 'package.json');
	const pkg = JSON.parse(readFileSync(pkg_file, 'utf8'));
	pkg.dependencies = { ...pkg.dependencies, ogygia: `file:${packed.ogygia}` };
	writeFileSync(pkg_file, JSON.stringify(pkg, null, 2) + '\n');
	const ws = join(app, 'pnpm-workspace.yaml');
	const before = existsSync(ws) ? readFileSync(ws, 'utf8') : '';
	if (/^overrides:/m.test(before))
		throw new Error(`${ws} already has overrides: merge them by hand`);
	writeFileSync(
		ws,
		`${before}${before && !before.endsWith('\n') ? '\n' : ''}overrides:\n  '@ogygia/core': 'file:${packed.core}'\n`
	);
}
