/**
 * The plugin API v2 (internal/notes/packages.md): config-time checks, realms found by name, the
 * generated `virtual:ogygia/server-plugins`, shared hooks, facts, route options, and the test starter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check_plugins, definePlugin, resolve_plugins } from '../src/vite/plugin-api.ts';
import { server_plugins_module, route_options_module } from '../src/compiler/link/caps.ts';
import { defineServer } from '../src/plugin/index.ts';
import { facts_of, mark_per_visitor } from '../src/plugin/facts.ts';
import { ask, notify, register_hooks } from '../src/plugin/hooks.ts';
import { clear_route_options, register_route_options, route_option, set_page_route_options } from '../src/plugin/routes.ts';
import { strip_route_options } from '../src/compiler/kit.ts';
import { startPlugin } from '../src/plugin/testing.ts';

/** The repo's playground: it depends on `@ogygia/flags`, which has a `./server` realm. */
const PLAYGROUND = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../apps/playground');

describe('ogygia({ plugins }) — config-time shape check', () => {
	it('names the uncalled factory', () => {
		const flags = () => definePlugin({ name: '@ogygia/flags' });
		expect(() => check_plugins([flags])).toThrow(/write `flags\(\)`/);
	});
	it('refuses a plugin listed twice, junk, and non-JSON options', () => {
		expect(() => check_plugins([definePlugin({ name: 'a' }), definePlugin({ name: 'a' })])).toThrow(/listed twice/);
		expect(() => check_plugins([{}])).toThrow(/must be a plugin/);
		expect(() => check_plugins(definePlugin({ name: 'a' }) as never)).toThrow(/must be an array/);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => check_plugins([definePlugin({ name: 'a', options: cyclic })])).toThrow(/plain JSON/);
	});
});

describe('realms, found by name', () => {
	it('a package with a `./server` export gets its server realm wired, options carried', () => {
		const out = resolve_plugins([definePlugin({ name: '@ogygia/flags', options: { x: 1 } })], PLAYGROUND, true);
		expect(out.servers).toEqual([{ name: '@ogygia/flags', module: '@ogygia/flags/server', options: { x: 1 } }]);
	});
	it('a name that is not a package the app resolves fails loudly', () => {
		expect(() => resolve_plugins([definePlugin({ name: '@ogygia/nope' })], PLAYGROUND, true)).toThrow(/no package by that name/);
	});
	it('`enforce` orders plugins: pre, the rest, post', () => {
		const seen: string[] = [];
		const p = (name: string, enforce?: 'pre' | 'post') =>
			definePlugin({ name: '@ogygia/flags', enforce, build: () => void seen.push(name) });
		// (one real package, three manifests: only the order of the build hooks is under test)
		resolve_plugins([p('mid'), p('last', 'post'), p('first', 'pre')], PLAYGROUND, true);
		expect(seen).toEqual(['first', 'mid', 'last']);
	});
	it('`b.routeOption` collects names; a Kit option or a second owner is refused', () => {
		const out = resolve_plugins([definePlugin({ name: '@ogygia/flags', build: (b) => b.routeOption('freeze') })], PLAYGROUND, true);
		expect(out.route_options).toEqual(['freeze']);
		expect(() => resolve_plugins([definePlugin({ name: '@ogygia/flags', build: (b) => b.routeOption('csr') })], PLAYGROUND, true)).toThrow(
			/Kit does not own/
		);
	});
	it('`b.pageModules` collects importer specifiers and absolute files, once each', () => {
		const file = path.join(PLAYGROUND, 'src/pages.ts');
		const out = resolve_plugins(
			[
				definePlugin({
					name: '@ogygia/flags',
					build: (b) => {
						b.pageModules({ importers: ['@ogygia/router'] });
						b.pageModules({ importers: ['@ogygia/router'], files: [file] });
					}
				})
			],
			PLAYGROUND,
			true
		);
		expect(out.page_modules).toEqual({ importers: ['@ogygia/router'], files: [file] });
		expect(() =>
			resolve_plugins([definePlugin({ name: '@ogygia/flags', build: (b) => b.pageModules({ files: ['src/pages.ts'] }) })], PLAYGROUND, true)
		).toThrow(/absolute paths/);
	});
});

describe('virtual:ogygia/server-plugins', () => {
	it('imports each server realm statically, with its name and options (server only)', () => {
		const code = server_plugins_module(true, [{ name: '@ogygia/flags', module: '@ogygia/flags/server', options: { a: 1 } }]);
		expect(code).toContain('import p0 from "@ogygia/flags/server";');
		expect(code).toContain('{ name: "@ogygia/flags", options: {"a":1}, server: p0 }');
	});
	it('is an empty list on the client and for an app without server realms', () => {
		expect(server_plugins_module(false, [{ name: 'x', module: 'x/server', options: {} }])).toBe('export const plugins = [];');
		expect(server_plugins_module(true, [])).toBe('export const plugins = [];');
	});
});

describe('shared hooks — notify / ask', () => {
	it('notify runs every implementation; ask takes the first answer', async () => {
		const seen: string[][] = [];
		const leave_a = register_hooks({ invalidate: (tags: string[]) => void seen.push(tags) });
		const leave_b = register_hooks({ invalidate: (tags: string[]) => void seen.push(tags.map((t) => t + '!')), lastBuild: () => 'v1' });
		const leave_c = register_hooks({ lastBuild: () => 'v2' });
		try {
			await notify.invalidate(['p:/a']);
			expect(seen).toEqual([['p:/a'], ['p:/a!']]);
			expect(await ask.lastBuild('v3')).toBe('v1');
		} finally {
			leave_a();
			leave_b();
			leave_c();
		}
	});
	it('nobody implementing: notify does nothing, ask answers undefined', async () => {
		await expect(notify.invalidated('all')).resolves.toBeUndefined();
		expect(await ask.lastBuild('v')).toBeUndefined();
	});
});

describe('facts', () => {
	it('are per request, made on first touch; the first per-visitor reason sticks', () => {
		const a = new Request('http://x/a');
		const facts = facts_of(a);
		expect(facts).toBe(facts_of(a));
		expect(facts_of(new Request('http://x/b'))).not.toBe(facts);
		mark_per_visitor(facts, 'flag:hero');
		mark_per_visitor(facts, 'cookie:x');
		expect(facts.perVisitor).toBe('flag:hero');
	});
});

describe('route options', () => {
	afterEach(() => clear_route_options());
	it('a programmatic router that claims the path wins; then the Kit page; else undefined', () => {
		set_page_route_options({ '/docs': { freeze: false }, '/plain': {} });
		register_route_options('t', (pathname, option) => (pathname === '/app' ? (option === 'freeze' ? true : null) : undefined));
		expect(route_option('freeze', null, '/app')).toBe(true);
		expect(route_option('freeze', '/(site)/docs', '/docs')).toBe(false);
		expect(route_option('freeze', '/plain', '/plain')).toBeUndefined();
		expect(route_option('freeze', null, '/nowhere')).toBeUndefined();
	});
	it('the compiler strips each declared option before Kit sees the file (length kept)', () => {
		const src = `export const freeze = false;\nexport const csr = false;\n`;
		const out = strip_route_options(src, ['freeze']);
		expect(out).not.toContain('freeze = false');
		expect(out).toContain('export const csr = false');
		expect(out.length).toBe(src.length);
	});
	it('the virtual module is server-only and empty without declared options', () => {
		expect(route_options_module(false, '/r', ['freeze'])).toBe('export const route_options = {};');
		expect(route_options_module(true, '/r', [])).toBe('export const route_options = {};');
	});
});

describe('startPlugin — a server realm without a server', () => {
	it('runs setup, registers shared hooks, and hands out request contexts', async () => {
		const calls: string[] = [];
		const server = defineServer<{ greeting: string }, { n: number }>({
			setup(app) {
				calls.push(`setup:${app.name}:${app.options.greeting}`);
			},
			state: () => ({ n: 1 }),
			request(ctx) {
				calls.push(`request:${ctx.path}:${ctx.state.n}`);
				ctx.perVisitor('test');
			},
			lastBuild: () => 'from-test'
		});
		const { app, ctx } = startPlugin(server, { name: 'test', options: { greeting: 'hi' } });
		const request = new Request('http://x/page');
		await server.request?.(ctx(request));
		expect(calls).toEqual(['setup:test:hi', 'request:/page:1']);
		expect(app.facts(request).perVisitor).toBe('test');
		expect(await ask.lastBuild('v')).toBe('from-test');
	});
});
