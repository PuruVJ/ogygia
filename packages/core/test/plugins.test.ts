/**
 * The plugin API v2 (internal/notes/packages.md): config-time checks, realms named by the plugin, the
 * generated `virtual:ogygia/server-plugins`, shared hooks, facts, route options, and the test starter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	check_plugins,
	definePlugin,
	find_plugins,
	PLUGIN,
	resolve_plugins,
	type PluginDefinition
} from '../src/vite/plugin-api.ts';
import { server_plugins_module, route_options_module } from '../src/compiler/link/caps.ts';
import { defineServer } from '../src/plugin/index.ts';
import { facts_of, mark_per_visitor } from '../src/plugin/facts.ts';
import { ask, notify, register_hooks } from '../src/plugin/hooks.ts';
import {
	clear_route_options,
	register_route_options,
	route_option,
	set_page_route_options
} from '../src/plugin/routes.ts';
import { strip_route_options } from '../src/compiler/kit.ts';
import { startPlugin } from '../src/plugin/testing.ts';

/** An app of the repo's (the federation demo's dash): it depends on `@ogygia/flags`. */
const APP = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../examples/mfe/dash'
);
/** a real server realm module */
const FLAGS_SERVER = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../flags/src/server.ts'
);

/** a definition as `resolve_plugins` takes it */
const def = <Options = undefined>(d: PluginDefinition<Options>): PluginDefinition<Options> => d;

describe('a plugin is a Vite plugin, found beside ogygia()', () => {
	it('definePlugin returns a Vite plugin carrying its definition', () => {
		const plugin = definePlugin({ name: '@ogygia/flags', options: { x: 1 } });
		expect(plugin.name).toBe('@ogygia/flags');
		expect(plugin[PLUGIN]).toEqual({ name: '@ogygia/flags', options: { x: 1 } });
		// a registered symbol: another copy of ogygia reads the same key; never an enumerable field
		expect(PLUGIN).toBe(Symbol.for('ogygia.plugin'));
		expect(Object.keys(plugin)).not.toContain('api');
	});
	it('finds definitions in the Vite list: nested arrays, promises, other plugins skipped, in order', async () => {
		const a = definePlugin({ name: 'a' });
		const b = definePlugin({ name: 'b' });
		const found = await find_plugins([
			{ name: 'ogygia' },
			[a, false, { name: 'other' }],
			Promise.resolve([b]),
			null
		]);
		expect(found.map((p) => p.name)).toEqual(['a', 'b']);
		expect(await find_plugins(undefined)).toEqual([]);
	});
	it('ogygia() and its plugins come before sveltekit()', async () => {
		const kit = [
			{ name: 'vite-plugin-sveltekit-setup' },
			{ name: 'vite-plugin-sveltekit-compile' }
		];
		const flags = definePlugin({ name: '@ogygia/flags' });
		await expect(find_plugins([{ name: 'ogygia' }, flags, kit])).resolves.toHaveLength(1);
		await expect(find_plugins([{ name: 'ogygia' }, kit, flags])).rejects.toThrow(
			/`@ogygia\/flags` is listed after `sveltekit\(\)`/
		);
		await expect(find_plugins([kit, [{ name: 'ogygia' }], flags])).rejects.toThrow(
			/`ogygia\(\)` is listed after `sveltekit\(\)`/
		);
	});
	it('names the uncalled factory', async () => {
		const flags = () => definePlugin({ name: '@ogygia/flags' });
		await expect(find_plugins([flags])).rejects.toThrow(/`flags\(\)`, not `flags`/);
	});
	it('refuses a plugin listed twice, a nameless one, and non-JSON options', async () => {
		await expect(
			find_plugins([definePlugin({ name: 'a' }), definePlugin({ name: 'a' })])
		).rejects.toThrow(/listed twice/);
		expect(() => check_plugins([{}])).toThrow(/needs a `name`/);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => check_plugins([def({ name: 'a', options: cyclic })])).toThrow(/plain JSON/);
	});
	it('listed without ogygia(), it fails the build saying what to add', () => {
		const plugin = definePlugin({ name: '@ogygia/flags' });
		const resolved = (names: string[]) => ({ plugins: names.map((name) => ({ name })) }) as never;
		const hook = plugin.configResolved as (config: never) => void;
		expect(() => hook(resolved(['@ogygia/flags', 'vite:svelte']))).toThrow(/`ogygia\(\)` is not/);
		expect(() => hook(resolved(['ogygia', '@ogygia/flags']))).not.toThrow();
	});
});

describe('realms, named by the plugin', () => {
	it('a plugin naming its `server` gets that module wired, options carried', () => {
		const posix = FLAGS_SERVER.split(path.sep).join('/');
		const plugin = def({
			name: '@ogygia/flags',
			server: pathToFileURL(FLAGS_SERVER).href,
			client: FLAGS_SERVER,
			options: { x: 1 }
		});
		const out = resolve_plugins([plugin], APP, true);
		expect(out.servers).toEqual([{ name: '@ogygia/flags', module: posix, options: { x: 1 } }]);
		expect(out.clients).toEqual([posix]);
	});
	it('no realm named, none wired: a package export called `./server` means nothing', () => {
		const out = resolve_plugins([def({ name: '@ogygia/flags' })], APP, true);
		expect(out.servers).toEqual([]);
		expect(out.clients).toEqual([]);
	});
	it('a realm that is not a file, or not a location, fails loudly', () => {
		expect(() =>
			resolve_plugins([def({ name: '@ogygia/flags', server: './server.ts' })], APP, true)
		).toThrow(/is not a file/);
		expect(() =>
			resolve_plugins([def({ name: '@ogygia/flags', server: FLAGS_SERVER + '.nope' })], APP, true)
		).toThrow(/is not a file/);
		expect(() => check_plugins([{ name: 'a', server: 1 }])).toThrow(/module location/);
	});
	it('a name that is not a package the app resolves fails loudly', () => {
		expect(() => resolve_plugins([def({ name: '@ogygia/nope' })], APP, true)).toThrow(
			/no package by that name/
		);
	});
	it('`enforce` orders plugins: pre, the rest, post', () => {
		const seen: string[] = [];
		const p = (name: string, enforce?: 'pre' | 'post') =>
			def({ name: '@ogygia/flags', enforce, build: () => void seen.push(name) });
		// (one real package, three manifests: only the order of the build hooks is under test)
		resolve_plugins([p('mid'), p('last', 'post'), p('first', 'pre')], APP, true);
		expect(seen).toEqual(['first', 'mid', 'last']);
	});
	it('`b.routeOption` collects names; a Kit option or a second owner is refused', () => {
		const out = resolve_plugins(
			[def({ name: '@ogygia/flags', build: (b) => b.routeOption('freeze') })],
			APP,
			true
		);
		expect(out.route_options).toEqual(['freeze']);
		expect(() =>
			resolve_plugins(
				[def({ name: '@ogygia/flags', build: (b) => b.routeOption('csr') })],
				APP,
				true
			)
		).toThrow(/Kit does not own/);
	});
	it('`b.pageModules` collects importer specifiers and absolute files, once each', () => {
		const file = path.join(APP, 'src/pages.ts');
		const out = resolve_plugins(
			[
				def({
					name: '@ogygia/flags',
					build: (b) => {
						b.pageModules({ importers: ['@ogygia/router'] });
						b.pageModules({ importers: ['@ogygia/router'], files: [file] });
					}
				})
			],
			APP,
			true
		);
		expect(out.page_modules).toEqual({ importers: ['@ogygia/router'], files: [file] });
		expect(() =>
			resolve_plugins(
				[def({ name: '@ogygia/flags', build: (b) => b.pageModules({ files: ['src/pages.ts'] }) })],
				APP,
				true
			)
		).toThrow(/absolute paths/);
	});
});

describe('virtual:ogygia/server-plugins', () => {
	it('imports each server realm statically, with its name and options (server only)', () => {
		const code = server_plugins_module(true, [
			{ name: '@ogygia/flags', module: '@ogygia/flags/server', options: { a: 1 } }
		]);
		expect(code).toContain('import p0 from "@ogygia/flags/server";');
		expect(code).toContain('{ name: "@ogygia/flags", options: {"a":1}, server: p0 }');
	});
	it('is an empty list on the client and for an app without server realms', () => {
		expect(server_plugins_module(false, [{ name: 'x', module: 'x/server', options: {} }])).toBe(
			'export const plugins = [];'
		);
		expect(server_plugins_module(true, [])).toBe('export const plugins = [];');
	});
});

describe('shared hooks — notify / ask', () => {
	it('notify runs every implementation; ask takes the first answer', async () => {
		const seen: string[][] = [];
		const leave_a = register_hooks({ invalidate: (tags: string[]) => void seen.push(tags) });
		const leave_b = register_hooks({
			invalidate: (tags: string[]) => void seen.push(tags.map((t) => t + '!')),
			lastBuild: () => 'v1'
		});
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
		register_route_options('t', (pathname, option) =>
			pathname === '/app' ? (option === 'freeze' ? true : null) : undefined
		);
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
