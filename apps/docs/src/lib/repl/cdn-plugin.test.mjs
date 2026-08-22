// Integration suite for the CDN plugin — node `rolldown` + LIVE jsdelivr, bundling real packages across
// the gnarly patterns and asserting the output. Network-dependent. Run: `node cdn-plugin.test.mjs`.
import { rolldown } from 'rolldown';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cdnPlugin } from './cdn-plugin.ts';
import { sveltePlugin } from './svelte-plugin.ts';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

/** Bundle an entry through the CDN plugin + svelte-compile; svelte stays external. `pkgs` collects
 *  resolved package names (a "resolving …" readout in the UI later). */
async function bundle(entryCode, { extraExternal, pkgs } = {}) {
	const files = { '/entry.js': entryCode };
	const workspace = {
		name: 'ws',
		resolveId(id) { return files[id] ? id : null; },
		load(id) { return files[id] ?? null; }
	};
	const b = await rolldown({
		input: '/entry.js',
		plugins: [
			workspace,
			cdnPlugin({ isExternal: extraExternal, onPackage: (n) => pkgs?.add(n) }),
			sveltePlugin()
		],
		cwd: '/',
		onLog() {}
	});
	const { output } = await b.generate({ format: 'es' });
	return output.map((o) => o.code).join('\n');
}

/** Bundle + actually RUN it (for npm-only cases), returning the module's exports. */
async function run(entryCode) {
	const code = await bundle(entryCode);
	const dir = await mkdtemp(join(tmpdir(), 'repl-cdn-'));
	const file = join(dir, 'out.mjs');
	await writeFile(file, code);
	try {
		return await import(pathToFileURL(file).href);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
const withNet = (p) => Promise.race([p, timeout(45000)]);

async function main() {
	console.log('CDN plugin — live jsdelivr integration\n');

	// 1. CJS package, default export (canvas-confetti)
	try {
		const m = await withNet(run(`import confetti from 'canvas-confetti';\nexport const t = typeof confetti;\nexport const hasReset = typeof confetti.reset;`));
		ok('CJS default export (canvas-confetti)', m.t === 'function', `typeof=${m.t}`);
		ok('CJS static props preserved (.reset)', m.hasReset === 'function');
	} catch (e) { fail += 2; console.log('  ✗ canvas-confetti threw —', e.message); }

	// 2. Pure ESM, named exports (nanoid)
	try {
		const m = await withNet(run(`import { nanoid, customAlphabet } from 'nanoid';\nexport const a = typeof nanoid;\nexport const b = typeof customAlphabet;\nexport const id = nanoid();`));
		ok('ESM named exports (nanoid)', m.a === 'function' && m.b === 'function');
		ok('ESM runtime works (nanoid() returns id)', typeof m.id === 'string' && m.id.length > 0, `id=${m.id}`);
	} catch (e) { fail += 2; console.log('  ✗ nanoid threw —', e.message); }

	// 3. Namespace import + ESM subpath (lodash-es)
	try {
		const m = await withNet(run(`import { debounce, cloneDeep } from 'lodash-es';\nexport const a = typeof debounce;\nexport const b = typeof cloneDeep;`));
		ok('ESM barrel named imports (lodash-es)', m.a === 'function' && m.b === 'function');
	} catch (e) { fail += 1; console.log('  ✗ lodash-es threw —', e.message); }

	// 4. CJS subpath (lodash/debounce)
	try {
		const m = await withNet(run(`import debounce from 'lodash/debounce';\nexport const t = typeof debounce;`));
		ok('CJS subpath default (lodash/debounce)', m.t === 'function', `typeof=${m.t}`);
	} catch (e) { fail += 1; console.log('  ✗ lodash/debounce threw —', e.message); }

	// 5. Scoped package with exports map + transitive deps (@floating-ui/dom → @floating-ui/core)
	try {
		const m = await withNet(run(`import { computePosition, autoUpdate } from '@floating-ui/dom';\nexport const a = typeof computePosition;\nexport const b = typeof autoUpdate;`));
		ok('scoped + exports map + transitive (@floating-ui/dom)', m.a === 'function' && m.b === 'function');
	} catch (e) { fail += 1; console.log('  ✗ @floating-ui/dom threw —', e.message); }

	// 6. Versioned specifier
	try {
		const m = await withNet(run(`import { nanoid } from 'nanoid@5.0.7';\nexport const t = typeof nanoid;`));
		ok('versioned specifier (nanoid@5.0.7)', m.t === 'function');
	} catch (e) { fail += 1; console.log('  ✗ nanoid@5.0.7 threw —', e.message); }

	// 7. svelte stays EXTERNAL (not bundled from CDN). `mount` is re-exported so it isn't tree-shaken.
	try {
		const code = await withNet(bundle(`import { mount } from 'svelte';\nimport confetti from 'canvas-confetti';\nexport { mount };\nexport const t = typeof confetti;`));
		const importsSvelte = /from\s*["']svelte["']/.test(code);
		const bundledSvelte = /jsdelivr[^\n]*svelte/.test(code);
		ok('svelte kept external (import preserved, not CDN-bundled)', importsSvelte && !bundledSvelte, `import=${importsSvelte} bundled=${bundledSvelte}`);
	} catch (e) { fail += 1; console.log('  ✗ svelte-external threw —', e.message); }

	// 7b. A Svelte component lib shipping `.svelte` SOURCE via a deep barrel (radix-svelte): the `svelte`
	//     export condition resolves, `export * from './components'` chains resolve, `.svelte` files
	//     compile, and svelte/internal stays external. THE hard one.
	try {
		const pkgs = new Set();
		const code = await withNet(bundle(
			`import { Accordion } from 'radix-svelte';\nexport const keys = Object.keys(Accordion);`,
			{ pkgs }
		));
		const compiled = /svelte\/internal\/client/.test(code); // .svelte files were compiled
		const svelteExternal = /from\s*["']svelte\/internal\/client["']/.test(code);
		ok('radix-svelte: svelte-source deep barrel bundles', code.length > 500 && pkgs.has('radix-svelte'), `pkgs=${[...pkgs]}`);
		ok('radix-svelte: .svelte compiled, svelte/internal external', compiled && svelteExternal, `compiled=${compiled} external=${svelteExternal}`);
	} catch (e) { fail += 2; console.log('  ✗ radix-svelte threw —', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }

	// 8. Node builtin → stubbed (doesn't crash the build)
	try {
		const m = await withNet(run(`import fs from 'fs';\nimport path from 'node:path';\nexport const a = typeof fs;\nexport const b = typeof path;`));
		ok('node builtins stubbed (fs, node:path)', m.a === 'object' && m.b === 'object');
	} catch (e) { fail += 1; console.log('  ✗ node-builtin stub threw —', e.message); }

	// 9. Unknown package → stub, build survives
	try {
		const m = await withNet(run(`import x from 'this-package-does-not-exist-9z9z9z';\nexport const t = typeof x;`));
		ok('unknown package stubbed (build survives)', m.t === 'object', `typeof=${m.t}`);
	} catch (e) { fail += 1; console.log('  ✗ unknown-package threw —', e.message); }

	// 10. JSON import from a package (immer ships no json; use a known-json path) — data URL-ish: skip if flaky
	try {
		const m = await withNet(run(`import pkg from 'nanoid/package.json';\nexport const name = pkg.name;`));
		ok('JSON import (nanoid/package.json)', m.name === 'nanoid', `name=${m.name}`);
	} catch (e) { fail += 1; console.log('  ✗ JSON import threw —', e.message); }

	console.log(`\n${'─'.repeat(44)}`);
	console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
