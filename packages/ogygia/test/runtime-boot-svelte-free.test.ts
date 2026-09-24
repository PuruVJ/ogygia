// INVARIANT: the browser runtime's BOOT — `runtime/core.ts` plus every feature's `install` module —
// never statically reaches Svelte. In a real app Svelte's client runtime is ONE shared chunk (~200 KB);
// anything in the boot's static graph downloads first thing in `<head>`, ahead of the page's LCP image,
// before a single island needs it (field: +1 s LCP on a content page). Svelte must arrive with the first
// hydrate (the lazy hydrate core + `slots.hydrate_features`), when `hydrate()` needs it anyway.
//
// It regressed four ways before this test existed: a string constant imported through a server-side
// module that imports `svelte`, a rune (`$effect.root`) in a module core imported statically, the
// hydrate-only `context` / `live` / `wire` features installing their Svelte-reaching modules eagerly,
// and `remote-seeds` pulling in the APP's transport codecs (its own `src/hooks.ts`) at boot.
//
// The walk uses the TypeScript AST: only real static edges (`import … from`, `export … from`, bare
// `import '…'`); type-only imports and `import()` are not edges. A `.svelte` component, a bare `svelte` /
// `svelte/*` specifier, or a `.svelte.ts` module that CALLS a rune is a Svelte dependency.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
	FEATURES,
	generateHydrateFeaturesSource,
	generateRuntimeEntrySource
} from '../src/compiler/link/runtime-entry.js';

const SRC = path.resolve(__dirname, '../src');
const RUNTIME = path.join(SRC, 'runtime');
// The devtools graph is imported by core but dead-code-eliminated behind `__OGYGIA_DEVTOOLS__` in a
// production build (verified: no devtools bytes in the built runtime chunk); it is a dev instrument.
const DEVTOOLS = path.join(SRC, 'devtools') + path.sep;
const RUNES = new Set(['$state', '$derived', '$effect', '$props', '$inspect']);
// Virtual modules that resolve to the APP's own code (the transport codecs from its `src/hooks.ts`):
// arbitrary app code can import anything — in practice `ogygia` itself, and so Svelte. The boot must
// never reach one; it is how the app's transport graph once put Svelte's runtime into `<head>`.
const APP_CODE = new Set(['virtual:ogygia/transport']);

function resolve(from: string, spec: string): string | null {
	const base = path.resolve(path.dirname(from), spec);
	for (const c of [base.replace(/\.js$/, '.ts'), base, base + '.ts']) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
	}
	return null;
}

/** The module's STATIC import edges (specifiers), and whether it calls a rune. */
function scan(file: string): { specs: string[]; runes: boolean } {
	const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const specs: string[] = [];
	let runes = false;
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) {
			const named = stmt.importClause?.namedBindings;
			const all_type =
				!stmt.importClause?.name &&
				named !== undefined &&
				ts.isNamedImports(named) &&
				named.elements.length > 0 &&
				named.elements.every((e) => e.isTypeOnly);
			if (!all_type) specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
		} else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && !stmt.isTypeOnly) {
			specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
		}
	}
	const visit = (n: ts.Node): void => {
		if (runes) return;
		if (ts.isCallExpression(n)) {
			const c = n.expression;
			const name = ts.isIdentifier(c)
				? c.text
				: ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)
					? c.expression.text
					: '';
			if (RUNES.has(name)) runes = true;
		}
		ts.forEachChild(n, visit);
	};
	if (file.endsWith('.svelte.ts')) visit(sf);
	return { specs, runes };
}

/** Every source file in `entry`'s static graph (devtools excluded, like the walker below). */
function static_files(entry: string): Map<string, string[]> {
	const seen = new Map<string, string[]>();
	const walk = (file: string, chain: string[]): void => {
		if (seen.has(file)) return;
		seen.set(file, chain);
		for (const spec of scan(file).specs) {
			if (!spec.startsWith('.') || spec.endsWith('.svelte')) continue;
			const next = resolve(file, spec);
			if (next && !next.startsWith(DEVTOOLS)) walk(next, [...chain, path.relative(SRC, next)]);
		}
	};
	walk(entry, [path.relative(SRC, entry)]);
	return seen;
}

/** Every chain from `entry` that ends in Svelte. */
function svelte_chains(entry: string): string[] {
	const seen = new Set<string>();
	const found: string[] = [];
	const walk = (file: string, chain: string[]): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const { specs, runes } = scan(file);
		if (runes) found.push([...chain, '(runes → svelte/internal/client)'].join(' > '));
		for (const spec of specs) {
			if (spec === 'svelte' || spec.startsWith('svelte/') || APP_CODE.has(spec)) {
				found.push([...chain, spec].join(' > '));
			} else if (spec.startsWith('.')) {
				if (spec.endsWith('.svelte')) {
					found.push([...chain, spec].join(' > '));
					continue;
				}
				const next = resolve(file, spec);
				if (next && !next.startsWith(DEVTOOLS)) walk(next, [...chain, path.relative(SRC, next)]);
			}
		}
	};
	walk(entry, [path.relative(SRC, entry)]);
	return found;
}

describe('the browser runtime boot never statically reaches Svelte', () => {
	it('core.ts', () => {
		expect(svelte_chains(path.join(RUNTIME, 'core.ts'))).toEqual([]);
	});

	for (const [id, def] of Object.entries(FEATURES)) {
		if ((def.phase ?? 'boot') !== 'boot') continue;
		it(`boot-phase feature "${id}" (${def.module})`, () => {
			const entry = resolve(path.join(RUNTIME, 'x.ts'), `./${def.module}`);
			expect(entry, `feature module ${def.module} resolves`).not.toBeNull();
			expect(svelte_chains(entry!)).toEqual([]);
		});
	}

	it('the walker is not vacuous: the lazy hydrate core DOES reach Svelte', () => {
		expect(svelte_chains(path.join(RUNTIME, 'hydrate-core.ts')).length).toBeGreaterThan(0);
	});
});

// The compiler places each feature in exactly one static phase. A hydrate-phase feature (it reaches
// Svelte) must never be imported by the generated BOOT entry — even when the app uses it — and must
// be imported by the generated hydrate-phase module, sized by the same marks.
describe('the compiler splits features into two static phases', () => {
	const EVERYTHING = {
		complete: true,
		hydrate: ['load', 'interaction', 'none'],
		defer: ['h'],
		router: true,
		live: true,
		wire: true,
		context: true,
		forms: true
	};
	const HYDRATE_PHASE = Object.entries(FEATURES)
		.filter(([, d]) => d.phase === 'hydrate')
		.map(([id]) => id);

	it('hydrate-phase features are exactly context, live, wire, remote-seeds', () => {
		expect(HYDRATE_PHASE.sort()).toEqual(['context', 'live', 'remote-seeds', 'wire']);
	});

	it('the boot entry never imports a hydrate-phase feature, even when the app uses all of them', () => {
		const { code, features } = generateRuntimeEntrySource(EVERYTHING, '/rt');
		for (const id of HYDRATE_PHASE) {
			expect(features).not.toContain(id);
			expect(code).not.toContain(`/rt/${FEATURES[id as keyof typeof FEATURES].module}`);
		}
		expect(features).toContain('router'); // boot-phase ones are still there
	});

	it('the hydrate-phase module imports exactly the hydrate features the marks select', () => {
		const used = generateHydrateFeaturesSource(EVERYTHING, '/rt');
		expect(used.features.sort()).toEqual(['context', 'live', 'remote-seeds', 'wire']);
		const plain = generateHydrateFeaturesSource({ complete: true, hydrate: ['load'], remoteSeeds: false }, '/rt');
		expect(plain.features).toEqual([]); // a plain app ships none of them
		expect(plain.code).toContain('export function install()');
	});
});

// ISLAND-SIDE CODE NEVER IMPORTS A BOOT MODULE. Island code is bundled apart from the runtime (an
// island chunk can load on a csr=true page where the runtime never boots), so a runtime module that
// island code imports is SHARED between the two graphs: the bundler must keep it — and everything
// the runtime's lazy chunks need from it — out of the runtime chunk. One `import … from
// '../runtime/router.js'` in the navigation shim split the boot into a dozen files. Island-side code
// reaches the running runtime through the navigation handle (runtime/nav-handle.ts) instead.
describe('island-side modules reach the runtime only through its handles', () => {
	const boot = new Map<string, string[]>();
	for (const f of static_files(path.join(RUNTIME, 'core.ts'))) boot.set(...f);
	for (const [, def] of Object.entries(FEATURES)) {
		if ((def.phase ?? 'boot') !== 'boot') continue;
		for (const f of static_files(resolve(path.join(RUNTIME, 'x.ts'), `./${def.module}`)!)) boot.set(...f);
	}
	// The modules island code is aliased to or imports directly (vite/paths.ts APP_SHIMS + the
	// kit-remote client stub, and the public `ogygia/app`).
	const ISLAND_SIDE = [
		'shims/app-navigation.ts',
		'shims/app-state.svelte.ts',
		'shims/app-stores.ts',
		'shims/kit-remote/client-stub.ts',
		'app.ts'
	];
	for (const rel of ISLAND_SIDE) {
		it(`${rel} imports no boot module`, () => {
			const reached = static_files(path.join(SRC, rel));
			const into_boot = [...reached].filter(([f]) => boot.has(f)).map(([, chain]) => chain.join(' > '));
			expect(into_boot).toEqual([]);
		});
	}

	it('the check is not vacuous: the boot set holds the router and the slots registry', () => {
		expect(boot.has(path.join(RUNTIME, 'router.ts'))).toBe(true);
		expect(boot.has(path.join(RUNTIME, 'slots.ts'))).toBe(true);
	});
});
