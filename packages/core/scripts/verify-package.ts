/**
 * Release gate — proves the PUBLISHED tarball is whole. `npm pack` produces exactly what ships;
 * this extracts it and asserts, for every declared export:
 *   1. every condition target (types / svelte / default) is a real file INSIDE the tarball
 *      (catches the classic break: an export pointing at a dist file the `files` field never shipped);
 *   2. every JS subpath has a `types` target (a consumer gets IntelliSense for it);
 *   3. server-safe subpaths actually `import()` from the packed package under Node;
 *   4. every subpath's types resolve for a consumer (and each types-only subpath's reference).
 *
 * Run against the current build: `node scripts/verify-package.ts [package dir]` — core by default.
 * `ogygia` (packages/ogygia) is a thin package over `@ogygia/core`: its workspace dependencies are
 * packed too and installed beside it in their published shape, so its re-exports are checked against
 * the core that would publish with it. Exit non-zero on any gap.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg_root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const fail = [];
const note = (m) => process.stdout.write(m + '\n');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ogygia-verify-'));
const tarballs = [];

/**
 * Pack one package, extract it, apply `publishConfig` and give it a node_modules: a real directory
 * whose entries link to the package's own install (so PEER deps — svelte, vite, … — resolve for real;
 * only Kit's virtual `$app`/`$env` stay absent), except its workspace dependencies, which are packed
 * and placed the same way (`ogygia` → `@ogygia/core`).
 */
function unpack(dir, into) {
	note(`▸ npm pack ${path.relative(process.cwd(), dir) || '.'} …`);
	const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', os.tmpdir()], {
		cwd: dir
	})
		.toString()
		.trim()
		.split('\n')
		.pop();
	const tarpath = path.join(os.tmpdir(), tarball);
	tarballs.push(tarpath);
	fs.mkdirSync(into, { recursive: true });
	execFileSync('tar', ['-xzf', tarpath, '-C', into, '--strip-components=1']); // npm tarballs nest under package/
	const manifest = JSON.parse(fs.readFileSync(path.join(into, 'package.json'), 'utf8'));
	const source = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	// `npm pack` does NOT apply `publishConfig` (only `npm publish` does), so the tarball carries the
	// DEV exports (src paths, for monorepo HMR). Apply publishConfig ourselves — exactly what publish
	// does — and write it back, so node/tsc below resolve against the PUBLISHED shape, not the dev one.
	if (manifest.publishConfig?.exports) {
		manifest.exports = manifest.publishConfig.exports;
		delete manifest.publishConfig;
		fs.writeFileSync(path.join(into, 'package.json'), JSON.stringify(manifest, null, 2));
	}
	const workspace = Object.entries(source.dependencies ?? {})
		.filter(([, spec]) => String(spec).startsWith('workspace:'))
		.map(([name]) => name);
	const own_nm = path.join(dir, 'node_modules');
	const nm = path.join(into, 'node_modules');
	fs.mkdirSync(nm, { recursive: true });
	const link = (rel) => {
		const target = path.join(own_nm, rel);
		if (fs.existsSync(target) && !fs.existsSync(path.join(nm, rel)))
			fs.symlinkSync(fs.realpathSync(target), path.join(nm, rel), 'dir');
	};
	for (const entry of fs.existsSync(own_nm) ? fs.readdirSync(own_nm) : []) {
		if (entry.startsWith('.')) continue;
		if (!entry.startsWith('@')) {
			if (!workspace.includes(entry)) link(entry);
			continue;
		}
		fs.mkdirSync(path.join(nm, entry), { recursive: true });
		for (const child of fs.readdirSync(path.join(own_nm, entry)))
			if (!workspace.includes(`${entry}/${child}`)) link(path.join(entry, child));
	}
	for (const name of workspace)
		unpack(fs.realpathSync(path.join(own_nm, name)), path.join(nm, name));
	return manifest;
}

const root = path.join(work, 'package');
const manifest = unpack(pkg_root, root);
const exports = manifest.exports;

const targets_of = (v) =>
	typeof v === 'string' ? { default: v } : v && typeof v === 'object' ? v : {};

// A failure at one of these boundaries is EXPECTED, not a package break: `$app`/`$env` are Kit
// virtual modules (exist only inside a Kit build), `virtual:` is a Vite virtual, and a `.svelte`
// import needs the Svelte compiler/loader (component subpaths aren't bare-Node importable). Reaching
// such a boundary PROVES the module's own graph loaded intact up to it.
const EXPECTED =
	/Cannot find package '\$app|Cannot find package '\$env|virtual:|Unknown file extension "\.svelte"/;

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

// 3. Node-import every JS subpath straight out of the packed package. Peers resolve (linked
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
//    subpath (and references every types-only one), and run `tsc --noEmit`. A type that doesn't
//    resolve is a compile error.
note('▸ tsc types resolution (consumer view) …');
const name = manifest.name;
const self = path.join(root, 'node_modules', name);
fs.mkdirSync(path.dirname(self), { recursive: true });
if (!fs.existsSync(self)) fs.symlinkSync(root, self, 'dir'); // `import 'ogygia/…'` → this package
const type_subpaths = Object.entries(exports).filter(([sp, val]) => {
	if (sp === './package.json') return false;
	const conds = targets_of(val);
	// Must be an importable MODULE to namespace-import its types: a pure-`types` subpath (no
	// default/svelte) is an AMBIENT `/// <reference>` file (e.g. `ogygia/types`), not a module.
	const is_module = 'default' in conds || 'svelte' in conds;
	return is_module && 'types' in conds && !String(conds.types).includes('*');
});
const ambient_subpaths = Object.entries(exports).filter(([sp, val]) => {
	const conds = targets_of(val);
	return (
		sp !== './package.json' &&
		!('default' in conds) &&
		!('svelte' in conds) &&
		typeof conds.types === 'string'
	);
});
// A namespace type-import that FAILS to resolve is a compile error (TS2307/2306); one that resolves
// is silent (unused type-only imports aren't flagged). So the imports alone are the assertion. A
// reference that fails to resolve is TS2688.
const consumer =
	ambient_subpaths.map(([sp]) => `/// <reference types="${name}${sp.slice(1)}" />`).join('\n') +
	'\n' +
	type_subpaths
		.map(([sp], i) => `import type * as _${i} from '${name}${sp.slice(1)}';`)
		.join('\n') +
	'\n';
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
	execFileSync(
		'node',
		[path.join(pkg_root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.verify.json'],
		{
			cwd: root,
			stdio: 'pipe'
		}
	);
	note(
		`  typechecked ${type_subpaths.length} subpaths' declarations, ${ambient_subpaths.length} ambient reference(s)`
	);
} catch (e) {
	const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
	// Only OUR subpaths' resolution matters; ignore peer-type noise (svelte/kit ambient) if any.
	const ours = out
		.split('\n')
		.filter((l) => l.includes(name) || /error TS2307|error TS2688|Cannot find module/.test(l));
	fail.push(
		`consumer types do not resolve:\n    ${(ours.length ? ours : out.split('\n')).slice(0, 6).join('\n    ')}`
	);
}

fs.rmSync(work, { recursive: true, force: true });
for (const t of tarballs) fs.rmSync(t, { force: true });

if (fail.length) {
	note(`\n✗ ${name}: package verification FAILED:`);
	for (const f of fail) note('  · ' + f);
	process.exit(1);
}
note(`\n✓ ${name} verified — ${Object.keys(exports).length} exports ship, resolve, and type-check`);
