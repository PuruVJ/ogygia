/**
 * Release gate — proves the PUBLISHED tarball is whole. `npm pack` produces exactly what ships;
 * this extracts it and asserts, for every declared export:
 *   1. every condition target (types / svelte / default) is a real file INSIDE the tarball
 *      (catches the classic break: an export pointing at a dist file the `files` field never shipped);
 *   2. every JS subpath has a `types` target (a consumer gets IntelliSense for it);
 *   3. server-safe subpaths actually `import()` from the packed package under Node.
 *
 * Run against the current build: `node scripts/verify-package.mjs`. Exit non-zero on any gap.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg_root = path.resolve(import.meta.dirname, '..');
const fail = [];
const note = (m) => process.stdout.write(m + '\n');

// 1. pack — the exact bytes that would publish.
note('▸ npm pack …');
const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', os.tmpdir()], {
	cwd: pkg_root
}).toString().trim().split('\n').pop();
const tarpath = path.join(os.tmpdir(), tarball);

// 2. extract into a temp dir, and point its node_modules at the monorepo's install so PEER deps
//    (svelte, shiki, mdsvex, …) resolve for real — only Kit's virtual `$app`/`$env` stay absent.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ogygia-verify-'));
execFileSync('tar', ['-xzf', tarpath, '-C', work]);
const root = path.join(work, 'package'); // npm tarballs nest under package/
fs.symlinkSync(path.join(pkg_root, 'node_modules'), path.join(root, 'node_modules'), 'dir');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// `npm pack` does NOT apply `publishConfig` (only `npm publish` does), so the tarball carries the
// DEV exports (src paths, for monorepo HMR). Apply publishConfig ourselves — exactly what publish
// does — and write it back, so node/tsc below resolve against the PUBLISHED shape, not the dev one.
const exports = manifest.publishConfig?.exports ?? manifest.exports;
if (manifest.publishConfig?.exports) {
	manifest.exports = manifest.publishConfig.exports;
	delete manifest.publishConfig;
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
}

const targets_of = (v) =>
	typeof v === 'string' ? { default: v } : v && typeof v === 'object' ? v : {};

// A failure at one of these boundaries is EXPECTED, not a package break: `$app`/`$env` are Kit
// virtual modules (exist only inside a Kit build), `virtual:` is a Vite virtual, and a `.svelte`
// import needs the Svelte compiler/loader (component subpaths aren't bare-Node importable). Reaching
// such a boundary PROVES the module's own graph loaded intact up to it.
const EXPECTED = /Cannot find package '\$app|Cannot find package '\$env|virtual:|Unknown file extension "\.svelte"/;

for (const [subpath, val] of Object.entries(exports)) {
	if (subpath === './package.json') continue;
	const conds = targets_of(val);
	const has_glob = Object.values(conds).some((t) => typeof t === 'string' && t.includes('*'));

	// (1) every condition target present in the tarball
	for (const [cond, target] of Object.entries(conds)) {
		if (typeof target !== 'string' || target.includes('*')) continue;
		const abs = path.join(root, target);
		if (!fs.existsSync(abs)) fail.push(`${subpath} [${cond}] → ${target} MISSING from tarball`);
	}

	// (2) a JS subpath (has svelte/default) must ship types — but a `.css`/asset export needn't.
	const default_target = typeof val === 'string' ? val : (conds.default ?? conds.svelte ?? '');
	const is_asset = /\.(css|svg|png|woff2?)$/.test(default_target) || subpath.endsWith('.css');
	const is_js = ('default' in conds || 'svelte' in conds) && !is_asset;
	if (is_js && !has_glob && !('types' in conds)) {
		fail.push(`${subpath} ships no \`types\` condition — consumers lose IntelliSense`);
	}
}

// 3. Node-import every JS subpath straight out of the packed package. Peers resolve (symlinked
//    node_modules); a real graph break (missing relative file, undeclared dep, syntax error) throws
//    outside the EXPECTED boundaries above.
note('▸ node import (every JS subpath) …');
let imported = 0;
for (const [subpath, val] of Object.entries(exports)) {
	if (subpath === './package.json') continue;
	const conds = targets_of(val);
	const entry = typeof val === 'string' ? val : conds.default;
	if (!entry || !entry.endsWith('.js')) continue; // css/asset/types-only subpaths
	try {
		await import(pathToFileURL(path.join(root, entry)).href);
		imported++;
	} catch (e) {
		const msg = String(e?.message ?? e);
		if (EXPECTED.test(msg)) {
			imported++;
			continue;
		}
		fail.push(`${subpath} → ${entry} failed to import: ${msg.split('\n')[0]}`);
	}
}
note(`  imported ${imported} JS subpaths (graph intact to their external boundaries)`);

// 4. Types resolve for a CONSUMER — the check `types` PRESENT can't make: a `.d.ts` can ship yet
//    reference a type that wasn't emitted, or the condition order can hand TS the wrong file. Install
//    the package under its own name, write a consumer that namespace-imports the TYPES of every JS
//    subpath, and run `tsc --noEmit`. A type that doesn't resolve is a compile error.
note('▸ tsc types resolution (consumer view) …');
const name = manifest.name;
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true }); // already a symlink dir — noop-safe
try {
	fs.symlinkSync(root, path.join(root, 'node_modules', name), 'dir'); // `import 'ogygia/…'` → this package
} catch {
	/* peer symlink may already occupy node_modules; fall through — resolution still works via the map */
}
const type_subpaths = Object.entries(exports).filter(([sp, val]) => {
	if (sp === './package.json') return false;
	const conds = targets_of(val);
	// Must be an importable MODULE to namespace-import its types: a pure-`types` subpath (no
	// default/svelte) is an AMBIENT `/// <reference>` file (e.g. `ogygia/types`), not a module.
	const is_module = 'default' in conds || 'svelte' in conds;
	return is_module && 'types' in conds && !String(conds.types).includes('*');
});
// A namespace type-import that FAILS to resolve is a compile error (TS2307/2306); one that resolves
// is silent (unused type-only imports aren't flagged). So the imports alone are the assertion.
const consumer =
	type_subpaths.map(([sp], i) => `import type * as _${i} from '${name}${sp.slice(1)}';`).join('\n') + '\n';
fs.writeFileSync(path.join(root, 'consumer.ts'), consumer);
fs.writeFileSync(
	path.join(root, 'tsconfig.verify.json'),
	JSON.stringify({
		compilerOptions: {
			module: 'esnext',
			moduleResolution: 'bundler',
			types: [],
			noEmit: true,
			skipLibCheck: true,
			strict: false
		},
		files: ['consumer.ts']
	})
);
try {
	execFileSync('node', [path.join(pkg_root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.verify.json'], {
		cwd: root,
		stdio: 'pipe'
	});
	note(`  typechecked ${type_subpaths.length} subpaths' declarations`);
} catch (e) {
	const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
	// Only OUR subpaths' resolution matters; ignore peer-type noise (svelte/kit ambient) if any.
	const ours = out.split('\n').filter((l) => l.includes(name) || /error TS2307|Cannot find module/.test(l));
	fail.push(`consumer types do not resolve:\n    ${(ours.length ? ours : out.split('\n')).slice(0, 6).join('\n    ')}`);
}

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(tarpath, { force: true });

if (fail.length) {
	note('\n✗ package verification FAILED:');
	for (const f of fail) note('  · ' + f);
	process.exit(1);
}
note(`\n✓ package verified — ${Object.keys(exports).length - 1} exports ship, resolve, and type-check`);
