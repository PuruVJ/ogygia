import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	read_freeze,
	freezeRouteIds,
	strip_freeze_export,
	is_route_option_file
} from '../src/compiler/kit.js';

// ─────────────────────────────────────────────────────────────────────────────
// FREEZE opt-in — `export const freeze = true|false` in a page/layout option file.
//
// It cascades exactly like `csr` (option-file chain, deepest declaration wins, layouts included),
// the config `default` fills an unset route, and ogygia STRIPS the export before Kit sees it (Kit's
// export validators reject any non-Kit page option). This suite pins the read, the cascade, the
// default, the strip (length-preserving), and the option-file predicate.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Materialize a routes tree: `{ 'a/+page.svelte': '...' }` → tmp routes dir. */
function routes(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'og-freeze-'));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

describe('read_freeze — export shapes', () => {
	it('reads true / false / undefined, and ignores a commented-out declaration', () => {
		const dir = routes({
			'on/+page.ts': 'export const freeze = true;',
			'off/+page.ts': 'export const freeze = false;',
			'typed/+page.ts': 'export const freeze: boolean = true;',
			'load/+page.server.ts': 'export const load = () => ({});',
			'commented/+page.ts': '// export const freeze = true\nexport const load = () => ({});'
		});
		expect(read_freeze(join(dir, 'on/+page.ts'))).toBe(true);
		expect(read_freeze(join(dir, 'off/+page.ts'))).toBe(false);
		expect(read_freeze(join(dir, 'typed/+page.ts'))).toBe(true);
		expect(read_freeze(join(dir, 'load/+page.server.ts'))).toBeUndefined();
		expect(read_freeze(join(dir, 'commented/+page.ts'))).toBeUndefined();
		expect(read_freeze(join(dir, 'nope/+page.ts'))).toBeUndefined(); // absent file
	});
});

describe('freezeRouteIds — cascade + config default', () => {
	it('OPT-IN (default false): only routes/layouts that declare true are in the set; children inherit', () => {
		const dir = routes({
			'+page.svelte': '<h1>home</h1>', // no decl → default false → out
			'docs/+layout.ts': 'export const freeze = true;', // layout opts the subtree IN
			'docs/+page.svelte': '<h1>docs</h1>', // inherits → in
			'docs/guide/+page.svelte': '<h1>guide</h1>', // inherits deeper → in
			'docs/draft/+page.svelte': '<h1>draft</h1>',
			'docs/draft/+page.ts': 'export const freeze = false;' // overrides → out
		});
		const ids = new Set(freezeRouteIds(dir, false));
		expect(ids.has('/docs')).toBe(true);
		expect(ids.has('/docs/guide')).toBe(true);
		expect(ids.has('/docs/draft')).toBe(false); // page override beats the layout
		expect(ids.has('/')).toBe(false); // no decl, default off
	});

	it('AUTO (default true): everything is in except an explicit opt-out subtree', () => {
		const dir = routes({
			'+page.svelte': '<h1>home</h1>', // default true → in
			'account/+layout.ts': 'export const freeze = false;', // opt the subtree OUT
			'account/+page.svelte': '<h1>account</h1>', // inherits false → out
			'account/orders/+page.svelte': '<h1>orders</h1>', // deeper → out
			'account/public/+page.svelte': '<h1>public</h1>',
			'account/public/+page.ts': 'export const freeze = true;' // re-opts IN under an off layout
		});
		const ids = new Set(freezeRouteIds(dir, true));
		expect(ids.has('/')).toBe(true);
		expect(ids.has('/account')).toBe(false);
		expect(ids.has('/account/orders')).toBe(false);
		expect(ids.has('/account/public')).toBe(true); // deepest wins, both directions
	});

	it('strips (group) segments so the id matches Kit route.id normalization', () => {
		const dir = routes({
			'(app)/dash/+page.svelte': '<h1>dash</h1>',
			'(app)/dash/+page.ts': 'export const freeze = true;'
		});
		const ids = new Set(freezeRouteIds(dir, false));
		expect(ids.has('/dash')).toBe(true);
		expect(ids.has('/(app)/dash')).toBe(false);
	});
});

describe('strip_freeze_export — removes the export, length-preserving', () => {
	it('blanks the declaration to a same-length comment and leaves the rest intact', () => {
		const src = `export const load = () => ({ x: 1 });\nexport const freeze = true;\n`;
		const out = strip_freeze_export(src);
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
			const out = strip_freeze_export(decl + '\n');
			expect(out).not.toMatch(/export\s+const\s+freeze/);
			expect(out.length).toBe(decl.length + 1);
		}
	});

	it('is a no-op when there is no freeze export', () => {
		const src = 'export const load = () => ({});\n';
		expect(strip_freeze_export(src)).toBe(src);
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
