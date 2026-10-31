/**
 * The BUILD side of a plugin (design: internal/notes/packages.md, plugin API v2): `definePlugin` and
 * the build context. Loads in plain node — vite.config imports it before any bundler runs.
 *
 *   export const freeze = (options: FreezeOptions = {}) =>
 *     definePlugin({
 *       name: '@ogygia/freeze',                        // the package name: the plugin's identity
 *       options,                                        // JSON; reaches the server realm as `app.options`
 *       server: import.meta.resolve('./server.ts'),     // the server realm (`defineServer`)
 *       build(b) { b.routeOption('freeze'); }
 *     });
 *
 * A plugin IS a Vite plugin: the app lists it beside `ogygia()` (`plugins: [ogygia(), freeze(),
 * sveltekit()]`), and `ogygia()` finds it there by the definition it carries under {@link PLUGIN} —
 * never by its name. A factory that needs Vite hooks of its own returns them beside it, as an array.
 *
 * REALMS are named by the plugin: `server` and `client` point at the modules themselves, resolved
 * next to the factory (`import.meta.resolve`), so they are the same files the package's own imports
 * reach and a plugin's modules exist once. A package's export names stay its own.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin as VitePlugin } from 'vite';
import type { ServerRealm } from '../compiler/link/caps.ts';

/** Where `definePlugin` puts the definition on the Vite plugin it returns. A registered symbol, so a
 *  second copy of ogygia in one app still recognizes the first's plugins. */
export const PLUGIN: unique symbol = Symbol.for('ogygia.plugin');

/** The value a plugin's factory returns: a Vite plugin carrying its definition. */
export interface OgygiaPlugin<Options = unknown> extends VitePlugin {
	readonly [PLUGIN]: PluginDefinition<Options>;
}

/** What a plugin is: the argument to `definePlugin`. */
export interface PluginDefinition<Options = unknown> {
	/** The plugin's package name (`'@ogygia/freeze'`): its identity. */
	name: string;
	/** The SERVER realm: a module whose default export is `defineServer({…})` (`ogygia/plugin`), as a
	 *  `file:` URL or an absolute path — `import.meta.resolve('./server.ts')`. */
	server?: string;
	/** The BROWSER realm: a module whose default export is `defineClient({…})` (`ogygia/plugin/client`),
	 *  booted on every page — same form as `server`. */
	client?: string;
	/** Settings for every realm (JSON: no functions, no clients — live objects are configured at
	 *  runtime, in hooks.server.ts). */
	options?: Options;
	/** Run before (`'pre'`) or after (`'post'`) the other plugins, in every realm. */
	enforce?: 'pre' | 'post';
	/** Build-time contributions, with the build context. */
	build?(b: BuildContext): void;
}

/** A `import.meta.og.<name>` macro: rewrites a module that contains the marker (it is called only
 *  then), before the island transform or region minting see it. Returns the new code (the same
 *  string when nothing changed). */
export type MacroHandler = (code: string, m: MacroContext) => string | Promise<string>;

/** What a macro knows about the module it rewrites. */
export interface MacroContext {
	/** The module id, query stripped. */
	readonly id: string;
	/** The id relative to the app root, POSIX (a stable identity for stamps). */
	readonly rel: string;
	readonly root: string;
	/** Markup extensions whose `<script>` blocks hold the macro calls (`.svelte`). */
	readonly markupExts: readonly string[];
}

/** A source format that becomes Svelte only through a preprocessor (markdown → Svelte): how its
 *  islands and its modules' own scoped CSS reach the build. */
export interface MarkupSource {
	/** The format's file extensions (`['.svx', '.md']`). */
	extensions: readonly string[];
	/** Discover the format's islands up front (build start, dev included): read each file, turn it
	 *  into Svelte, and hand that to `transform` so its islands are registered before chunks emit. */
	scan?(ctx: { root: string; readFile(abs: string): string | null }): void | Promise<void>;
	/** Modules that carry their OWN scoped `<style>`, absolute path → their post-preprocess Svelte
	 *  source: the build compiles each one's CSS and ships it as a client asset (the module itself
	 *  only ever renders on the server). The plugin keeps filling this map; the build reads it late. */
	styles?: ReadonlyMap<string, string>;
}

/** What the build hands back for a markup source: run the region transform on preprocessed Svelte. */
export interface MarkupRegions {
	/** Rewrite the marked imports in already-preprocessed Svelte and register its regions. The code,
	 *  or null when nothing changed. */
	transform(source: string, filename: string): string | null;
}

/** The build, as one plugin sees it (handed to `build`). */
export interface BuildContext {
	/** The app's root directory. */
	readonly root: string;
	/** `vite dev` (true) or `vite build` (false). */
	readonly dev: boolean;
	/** A per-route boolean this plugin reads (`export const <name> = true|false` in a page or layout
	 *  option file, cascaded like `csr`): stripped before Kit sees the file, read back on the server
	 *  with `ctx.routeOption(name)`. */
	routeOption(name: string): void;
	/** Keep the foreign-hydrate exports on this app's island entries: another app's page may host
	 *  them and wake them through its own runtime (fragment federation). Off by default — they cost
	 *  every island ~185 B gz and a preload. */
	foreignHydrate(): void;
	/** An `import.meta.og.<name>(…)` construct this plugin compiles (`'code'`, `'loader'`). Plugin
	 *  macros run after core's own (`wire`, `$`, `source`, `store`) and before `bake`, in plugin order. */
	macro(name: string, handler: MacroHandler): void;
	/** A source format that becomes Svelte through a preprocessor (markdown): register it, get the
	 *  island transform to call from that preprocessor. */
	markup(source: MarkupSource): MarkupRegions;
	/** Compile core's EVENT emits in, browser and server (`ogygia/events`: island wakes, server renders,
	 *  hub mints, navigations) — off, every emit folds away. `lazy`: measure only once a viewer opens a
	 *  tool (the page carries a launcher; a preview build). */
	events(options?: { lazy?: boolean }): void;
	/** Record the build's MEASUREMENT data: per-island detail, chunk contents, server source maps, the
	 *  module map, the embedded maps, the request stats' detail — what a profiler reads. */
	measure(): void;
	/** Compile a package's files as app source (their islands, router-css roots): `dirs` / `files`
	 *  absolute, under `root` (the package's directory). For a plugin's own pages (a UI it serves). */
	files(scan: { root: string; dirs?: string[]; files?: string[] }): void;
	/** Modules that render pages outside Kit's routes (a programmatic router): every component they
	 *  import gets its whole-tree CSS linked when it renders (`componentCssHead()` from
	 *  `ogygia/plugin/css`). `importers`: any compiled module importing one of these specifiers is a
	 *  page module; `files`: absolute paths that are page modules themselves (compiled ones: app source,
	 *  or a `files()` / `ogygia.files` surface). */
	pageModules(modules: { importers?: string[]; files?: string[] }): void;
}

/** The name of `ogygia()`'s own Vite plugin: what a listed plugin looks for beside it. */
const OGYGIA_VITE_PLUGIN = 'ogygia';

/** A plugin, as the Vite plugin the app lists beside `ogygia()`. */
export function definePlugin<Options = undefined>(
	definition: PluginDefinition<Options>
): OgygiaPlugin<Options> {
	return {
		name: definition.name,
		[PLUGIN]: definition,
		configResolved(config) {
			if (!config.plugins.some((p) => p.name === OGYGIA_VITE_PLUGIN))
				throw new Error(
					`[ogygia] \`${definition.name}\` is listed in vite.config but \`ogygia()\` is not — add \`ogygia()\` from \`ogygia/vite\` to \`plugins\`.`
				);
		}
	};
}

/** The prefix of SvelteKit's own Vite plugins' names (`sveltekit()` returns several). */
const KIT_VITE_PLUGIN_PREFIX = 'vite-plugin-sveltekit';

/** The plugin definitions in the app's Vite plugin list (nested arrays and promises included), in
 *  list order, shape-checked. `ogygia()` and its plugins come before `sveltekit()`: Vite runs
 *  same-stage hooks in list order, and theirs (the content pre-transforms, the config ogygia hands
 *  Kit) must see a module before Kit's do. */
export async function find_plugins(list: unknown): Promise<PluginDefinition[]> {
	const found: unknown[] = [];
	let kit_seen = false;
	const walk = async (entry: unknown): Promise<void> => {
		const value = await entry;
		if (Array.isArray(value)) {
			for (const item of value) await walk(item);
			return;
		}
		if (typeof value === 'function')
			throw new Error(
				'[ogygia] a function is listed in vite.config `plugins` — call the factory: `flags()`, not `flags`.'
			);
		const plugin = value as { name?: unknown; [PLUGIN]?: { name?: unknown } } | null;
		const name = typeof plugin?.name === 'string' ? plugin.name : '';
		const definition = plugin?.[PLUGIN];
		if (name.startsWith(KIT_VITE_PLUGIN_PREFIX)) kit_seen = true;
		const own = name === OGYGIA_VITE_PLUGIN;
		if ((own || definition) && kit_seen)
			throw new Error(
				`[ogygia] \`${own ? 'ogygia()' : String(definition?.name)}\` is listed after \`sveltekit()\` in vite.config — list \`ogygia()\` and its plugins first: \`plugins: [ogygia(), flags(), sveltekit()]\`.`
			);
		if (definition) found.push(definition);
	};
	await walk(list);
	return check_plugins(found);
}

/** What the build takes from the app's plugins. */
export interface ResolvedPlugins {
	/** each server realm, in plugin order (`enforce` applied) */
	servers: ServerRealm[];
	/** each browser realm (an absolute path), in plugin order */
	clients: string[];
	/** every route option any plugin reads */
	route_options: string[];
	/** a plugin asked for island entries' foreign-hydrate exports */
	foreign_hydrate: boolean;
	/** plugin macros, in plugin order */
	macros: { name: string; handler: MacroHandler }[];
	/** markup sources (a preprocessor format with islands) */
	markup: MarkupSource[];
	/** a plugin asked for core's events (`lazy`: measure once a tool opens), or false */
	events: false | { lazy: boolean };
	/** a plugin asked for the build's measurement data */
	measure: boolean;
	/** package files compiled as app source, per plugin */
	files: { name: string; root: string; dirs: string[]; files: string[] }[];
	/** page modules (`b.pageModules()`): the specifiers whose importers are page modules, and files
	 *  that are page modules themselves */
	page_modules: { importers: string[]; files: string[] };
}

const MACRO_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** core's own `import.meta.og.*` constructs: a plugin may never claim one */
const CORE_MACROS = new Set(['wire', '$', 'source', 'store', 'bake']);

function order(plugins: readonly PluginDefinition[]): PluginDefinition[] {
	return [
		...plugins.filter((p) => p.enforce === 'pre'),
		...plugins.filter((p) => p.enforce !== 'pre' && p.enforce !== 'post'),
		...plugins.filter((p) => p.enforce === 'post')
	];
}

const ROUTE_OPTION_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** Kit's own page options: a plugin may never claim one. */
const KIT_ROUTE_OPTIONS = new Set([
	'csr',
	'ssr',
	'prerender',
	'trailingSlash',
	'config',
	'entries'
]);

/**
 * Config-time shape check of the definitions found: each named once, its realms locations, its
 * options JSON.
 */
export function check_plugins(plugins: readonly unknown[]): PluginDefinition[] {
	const seen = new Set<string>();
	for (const p of plugins) {
		const plugin = p as Partial<PluginDefinition> | null;
		if (
			!plugin ||
			typeof plugin !== 'object' ||
			typeof plugin.name !== 'string' ||
			plugin.name === ''
		)
			throw new Error('[ogygia] a plugin definition needs a `name` (its package name).');
		if (seen.has(plugin.name))
			throw new Error(`[ogygia] plugin \`${plugin.name}\` is listed twice.`);
		seen.add(plugin.name);
		for (const realm of ['server', 'client'] as const)
			if (plugin[realm] !== undefined && typeof plugin[realm] !== 'string')
				throw new Error(
					`[ogygia] plugin \`${plugin.name}\`: \`${realm}\` is a module location — \`import.meta.resolve('./${realm}.ts')\`.`
				);
		if (plugin.options !== undefined) {
			try {
				JSON.stringify(plugin.options);
			} catch {
				throw new Error(
					`[ogygia] plugin \`${plugin.name}\`: \`options\` must be plain JSON (configure live objects in hooks.server.ts).`
				);
			}
		}
	}
	return plugins as PluginDefinition[];
}

/** A realm's module as an absolute POSIX path (what the generated imports name), or null when the
 *  plugin has none. A location that is not a file is a mistake, said loudly. */
function realm_path(plugin: PluginDefinition, realm: 'server' | 'client'): string | null {
	const where = plugin[realm];
	if (where === undefined) return null;
	const abs = where.startsWith('file:') ? fileURLToPath(where) : where;
	if (!path.isAbsolute(abs) || !fs.existsSync(abs))
		throw new Error(
			`[ogygia] plugin \`${plugin.name}\`: its \`${realm}\` realm \`${where}\` is not a file — resolve it next to the factory: \`import.meta.resolve('./${realm}.ts')\`.`
		);
	return abs.split(path.sep).join('/');
}

function package_resolves(req: NodeJS.Require, name: string): boolean {
	try {
		req.resolve(`${name}/package.json`);
		return true;
	} catch (e) {
		// a package whose exports do not list package.json still resolves (the error says so)
		return (e as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
	}
}

/**
 * When the app's root and mode are known (the `config` hook): order the plugins (`enforce`), check their
 * realms, run their `build` hooks. `markup_transform` is the configured compiler's island
 * transform for preprocessed markup (what `b.markup()` hands back).
 */
export function resolve_plugins(
	plugins: readonly PluginDefinition[],
	root: string,
	dev: boolean,
	markup_transform: MarkupRegions['transform'] = () => null
): ResolvedPlugins {
	const ordered = order(plugins);
	const req = createRequire(path.join(root, 'package.json'));
	const out: ResolvedPlugins = {
		servers: [],
		clients: [],
		route_options: [],
		foreign_hydrate: false,
		macros: [],
		markup: [],
		events: false,
		measure: false,
		files: [],
		page_modules: { importers: [], files: [] }
	};
	const option_owner = new Map<string, string>();
	const macro_owner = new Map<string, string>();
	for (const plugin of ordered) {
		if (!package_resolves(req, plugin.name))
			throw new Error(
				`[ogygia] plugin \`${plugin.name}\`: no package by that name resolves from ${root} — its name must be its package name.`
			);
		const server = realm_path(plugin, 'server');
		if (server)
			out.servers.push({ name: plugin.name, module: server, options: plugin.options ?? {} });
		const client = realm_path(plugin, 'client');
		if (client) out.clients.push(client);
		plugin.build?.({
			root,
			dev,
			routeOption(name) {
				if (!ROUTE_OPTION_NAME_RE.test(name) || KIT_ROUTE_OPTIONS.has(name))
					throw new Error(
						`[ogygia] plugin \`${plugin.name}\`: route option \`${name}\` must be a camelCase identifier Kit does not own.`
					);
				const owner = option_owner.get(name);
				if (owner && owner !== plugin.name)
					throw new Error(
						`[ogygia] route option \`${name}\` is claimed by both \`${owner}\` and \`${plugin.name}\`.`
					);
				if (!owner) {
					option_owner.set(name, plugin.name);
					out.route_options.push(name);
				}
			},
			foreignHydrate() {
				out.foreign_hydrate = true;
			},
			macro(name, handler) {
				if (!MACRO_NAME_RE.test(name) || CORE_MACROS.has(name))
					throw new Error(
						`[ogygia] plugin \`${plugin.name}\`: macro \`import.meta.og.${name}\` must be a camelCase name core does not own.`
					);
				const owner = macro_owner.get(name);
				if (owner)
					throw new Error(
						`[ogygia] macro \`import.meta.og.${name}\` is claimed by both \`${owner}\` and \`${plugin.name}\`.`
					);
				macro_owner.set(name, plugin.name);
				out.macros.push({ name, handler });
			},
			markup(source) {
				out.markup.push(source);
				return { transform: markup_transform };
			},
			events(options) {
				// eager wins: one plugin measuring from boot outranks another's launcher-only ask
				const lazy = options?.lazy === true;
				out.events = out.events ? { lazy: out.events.lazy && lazy } : { lazy };
			},
			measure() {
				out.measure = true;
			},
			files(scan) {
				out.files.push({
					name: plugin.name,
					root: scan.root,
					dirs: scan.dirs ?? [],
					files: scan.files ?? []
				});
			},
			pageModules(modules) {
				for (const spec of modules.importers ?? [])
					if (!out.page_modules.importers.includes(spec)) out.page_modules.importers.push(spec);
				for (const file of modules.files ?? []) {
					if (!path.isAbsolute(file))
						throw new Error(
							`[ogygia] plugin \`${plugin.name}\`: \`pageModules({ files })\` takes absolute paths (got \`${file}\`).`
						);
					if (!out.page_modules.files.includes(file)) out.page_modules.files.push(file);
				}
			}
		});
	}
	return out;
}
