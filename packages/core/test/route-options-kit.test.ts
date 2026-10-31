import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	read_route_option,
	page_route_options,
	strip_route_options,
	is_route_option_file,
	clear_route_csr_cache
} from '../src/compiler/kit.ts';
import { route_option, set_page_route_options, clear_route_options } from '../src/plugin/routes.ts';

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE OPTIONS in Kit's file world — a plugin's `export const <name> = true|false` in a page/layout
// option file (freeze's `export const freeze` is the example used here).
//
// It cascades exactly like `csr` (option-file chain, deepest declaration wins, layouts included),
// an undeclared route carries no value (the plugin's own default applies at runtime), and ogygia
// STRIPS the export before Kit sees it (Kit's export validators reject any non-Kit page option).
// This suite pins the read, the cascade, the strip (length-preserving), and the option-file
// predicate.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	clear_route_csr_cache();
	clear_route_options();
});

/** Materialize a routes tree: `{ 'a/+page.svelte': '...' }` → tmp routes dir. */
function routes(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'og-route-options-'));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

/** The value the freeze plugin acts on: the declared one, else its config `default`. */
const effective = (
	options: Record<string, Record<string, boolean>>,
	id: string,
	fallback: boolean
) => options[id]?.freeze ?? fallback;

describe('read_route_option — export shapes', () => {
	it('reads true / false / undefined, and ignores a commented-out declaration', () => {
		const dir = routes({
			'on/+page.ts': 'export const freeze = true;',
			'off/+page.ts': 'export const freeze = false;',
			'typed/+page.ts': 'export const freeze: boolean = true;',
			'load/+page.server.ts': 'export const load = () => ({});',
			'commented/+page.ts': '// export const freeze = true\nexport const load = () => ({});'
		});
		expect(read_route_option(join(dir, 'on/+page.ts'), 'freeze')).toBe(true);
		expect(read_route_option(join(dir, 'off/+page.ts'), 'freeze')).toBe(false);
		expect(read_route_option(join(dir, 'typed/+page.ts'), 'freeze')).toBe(true);
		expect(read_route_option(join(dir, 'load/+page.server.ts'), 'freeze')).toBeUndefined();
		expect(read_route_option(join(dir, 'commented/+page.ts'), 'freeze')).toBeUndefined();
		expect(read_route_option(join(dir, 'nope/+page.ts'), 'freeze')).toBeUndefined(); // absent file
	});

	it('reads only the named option', () => {
		const dir = routes({ 'a/+page.ts': 'export const freeze = true;' });
		expect(read_route_option(join(dir, 'a/+page.ts'), 'other')).toBeUndefined();
	});
});

describe('page_route_options — the cascade', () => {
	it('opt-in subtree: a layout declares true, children inherit, a page overrides; undeclared is absent', () => {
		const dir = routes({
			'+page.svelte': '<h1>home</h1>', // no decl → absent
			'docs/+layout.ts': 'export const freeze = true;', // layout opts the subtree IN
			'docs/+page.svelte': '<h1>docs</h1>', // inherits → true
			'docs/guide/+page.svelte': '<h1>guide</h1>', // inherits deeper → true
			'docs/draft/+page.svelte': '<h1>draft</h1>',
			'docs/draft/+page.ts': 'export const freeze = false;' // overrides → false
		});
		const options = page_route_options(dir, ['freeze']);
		expect(options).toEqual({
			'/': {},
			'/docs': { freeze: true },
			'/docs/guide': { freeze: true },
			'/docs/draft': { freeze: false } // page override beats the layout
		});
		// with the plugin's `default: false` applied at runtime, only the declared-true pages store
		expect(effective(options, '/', false)).toBe(false);
		expect(effective(options, '/docs/guide', false)).toBe(true);
		expect(effective(options, '/docs/draft', false)).toBe(false);
	});

	it('opt-out subtree: a layout declares false and a page re-opts in; deepest wins both ways', () => {
		const dir = routes({
			'+page.svelte': '<h1>home</h1>', // no decl
			'account/+layout.ts': 'export const freeze = false;', // opt the subtree OUT
			'account/+page.svelte': '<h1>account</h1>', // inherits false
			'account/orders/+page.svelte': '<h1>orders</h1>', // deeper → false
			'account/public/+page.svelte': '<h1>public</h1>',
			'account/public/+page.ts': 'export const freeze = true;' // re-opts IN under an off layout
		});
		const options = page_route_options(dir, ['freeze']);
		expect(options['/']).toEqual({});
		expect(options['/account']).toEqual({ freeze: false });
		expect(options['/account/orders']).toEqual({ freeze: false });
		expect(options['/account/public']).toEqual({ freeze: true });
		// with `default: true` applied at runtime, everything stores except the opted-out subtree
		expect(effective(options, '/', true)).toBe(true);
		expect(effective(options, '/account/orders', true)).toBe(false);
		expect(effective(options, '/account/public', true)).toBe(true);
	});

	it('several options are read independently per page', () => {
		const dir = routes({
			'+layout.ts': 'export const freeze = true;\nexport const other = false;',
			'a/+page.svelte': '<h1>a</h1>',
			'b/+page.svelte': '<h1>b</h1>',
			'b/+page.ts': 'export const other = true;'
		});
		const options = page_route_options(dir, ['freeze', 'other']);
		expect(options['/a']).toEqual({ freeze: true, other: false });
		expect(options['/b']).toEqual({ freeze: true, other: true });
	});

	it('strips (group) segments so the id matches Kit route.id normalization', () => {
		const dir = routes({
			'(app)/dash/+page.svelte': '<h1>dash</h1>',
			'(app)/dash/+page.ts': 'export const freeze = true;'
		});
		const options = page_route_options(dir, ['freeze']);
		expect(options['/dash']).toEqual({ freeze: true });
		expect(options['/(app)/dash']).toBeUndefined();
	});

	it('baked values answer at runtime by Kit route.id (groups and all); undeclared = undefined', () => {
		const dir = routes({
			'+page.svelte': '<h1>home</h1>',
			'(app)/dash/+page.svelte': '<h1>dash</h1>',
			'(app)/dash/+page.ts': 'export const freeze = false;'
		});
		set_page_route_options(page_route_options(dir, ['freeze']));
		expect(route_option('freeze', '/(app)/dash', '/dash')).toBe(false);
		expect(route_option('freeze', '/', '/')).toBe(undefined);
		expect(route_option('freeze', '/', '/') ?? true).toBe(true); // the plugin default fills it
		expect(route_option('freeze', null, '/dash')).toBe(undefined); // no route: never normalized to '/'
	});
});

describe('strip_route_options — removes the export, length-preserving', () => {
	it('blanks the declaration to a same-length comment and leaves the rest intact', () => {
		const src = `export const load = () => ({ x: 1 });\nexport const freeze = true;\n`;
		const out = strip_route_options(src, ['freeze']);
		expect(out).not.toMatch(/export\s+const\s+freeze/);
		expect(out).toContain('export const load = () => ({ x: 1 });'); // sibling export survives
		expect(out.length).toBe(src.length); // byte offsets (source maps) untouched
	});

	it('handles the false / typed / no-semicolon forms', () => {
		for (const decl of [
			'export const freeze = false;',
			'export const freeze: boolean = true;',
			'export const freeze = true'
		]) {
			const out = strip_route_options(decl + '\n', ['freeze']);
			expect(out).not.toMatch(/export\s+const\s+freeze/);
			expect(out.length).toBe(decl.length + 1);
		}
	});

	it('is a no-op when there is no declared export, and strips only the named options', () => {
		const src = 'export const load = () => ({});\n';
		expect(strip_route_options(src, ['freeze'])).toBe(src);
		const both = 'export const freeze = true;\nexport const other = false;\n';
		const out = strip_route_options(both, ['freeze']);
		expect(out).not.toMatch(/export\s+const\s+freeze/);
		expect(out).toContain('export const other = false;');
		expect(strip_route_options(both, ['freeze', 'other'])).not.toMatch(/export\s+const/);
	});
});

describe('is_route_option_file', () => {
	const routesDir = '/app/src/routes';
	it('matches the four page/layout option files under the routes dir', () => {
		for (const f of [
			'/app/src/routes/+page.ts',
			'/app/src/routes/+page.server.ts',
			'/app/src/routes/+layout.js',
			'/app/src/routes/deep/x/+layout.server.ts',
			'/app/src/routes/x/+page.ts?some=query'
		]) {
			expect(is_route_option_file(f, routesDir)).toBe(true);
		}
	});
	it('rejects components, endpoints, and files outside the routes dir', () => {
		for (const f of [
			'/app/src/routes/+page.svelte', // host, not an option file
			'/app/src/routes/+server.ts', // endpoint
			'/app/src/routes/Comp.ts', // plain module
			'/app/src/lib/+page.ts' // outside routes
		]) {
			expect(is_route_option_file(f, routesDir)).toBe(false);
		}
	});
});
