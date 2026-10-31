/**
 * The BUILD side of a plugin (design: internal/notes/packages.md, plugin API v2): `definePlugin` and
 * the build context. Loads in plain node — vite.config imports it before any bundler runs.
 *
 *   export const freeze = (options: FreezeOptions = {}) =>
 *     definePlugin({
 *       name: '@ogygia/freeze',            // the package name: the plugin's identity
 *       options,                            // JSON; reaches the server realm as `app.options`
 *       build(b) { b.routeOption('freeze'); }
 *     });
 *
 * REALMS are found by name: the package's own `./server`, `./client`, `./devtools` exports. They
 * resolve through the package's exports exactly like the app's imports of the package, so a plugin's
 * modules exist once (never a src copy beside a dist copy).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin as VitePlugin } from 'vite';
import type { ServerRealm } from '../compiler/link/caps.js';

/** What an app puts in `ogygia({ plugins })` — the value a plugin's factory returns. */
export interface OgygiaPlugin<Options = unknown> {
	/** The plugin's package name (`'@ogygia/freeze'`): its identity, and where its realms live. */
	name: string;
	/** Settings for every realm (JSON: no functions, no clients — live objects are configured at
	 *  runtime, in hooks.server.ts). */
	options?: Options;
	/** Run before (`'pre'`) or after (`'post'`) the other plugins, in every realm. */
	enforce?: 'pre' | 'post';
	/** Vite plugins this plugin brings (ogygia's own plugin list carries them, before its own). */
	vite?: VitePlugin[];
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

/** What the build hands back for a markup source: run the island transform on preprocessed Svelte. */
export interface MarkupIslands {
	/** Rewrite the marked imports in already-preprocessed Svelte and register its islands. The code,
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
	markup(source: MarkupSource): MarkupIslands;
}

/** Typed identity: a plugin. */
export function definePlugin<Options = undefined>(plugin: OgygiaPlugin<Options>): OgygiaPlugin<Options> {
	return plugin;
}

/** The realms a plugin may have, as package export subpaths. */
const REALMS = ['server', 'client', 'devtools'] as const;

/** What the build takes from `ogygia({ plugins })`. */
export interface ResolvedPlugins {
	/** each server realm, in plugin order (`enforce` applied) */
	servers: ServerRealm[];
	/** every route option any plugin reads */
	route_options: string[];
	/** a plugin asked for island entries' foreign-hydrate exports */
	foreign_hydrate: boolean;
	/** plugin macros, in plugin order */
	macros: { name: string; handler: MacroHandler }[];
	/** markup sources (a preprocessor format with islands) */
	markup: MarkupSource[];
}

const MACRO_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** core's own `import.meta.og.*` constructs: a plugin may never claim one */
const CORE_MACROS = new Set(['wire', '$', 'source', 'store', 'bake']);

/** Collect each plugin's Vite plugins, in plugin order (`ogygia()` places them before its own). */
export function plugin_vite_plugins(plugins: readonly OgygiaPlugin[]): VitePlugin[] {
	return order(plugins).flatMap((p) => p.vite ?? []);
}

function order(plugins: readonly OgygiaPlugin[]): OgygiaPlugin[] {
	return [
		...plugins.filter((p) => p.enforce === 'pre'),
		...plugins.filter((p) => p.enforce !== 'pre' && p.enforce !== 'post'),
		...plugins.filter((p) => p.enforce === 'post')
	];
}

const ROUTE_OPTION_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** Kit's own page options: a plugin may never claim one. */
const KIT_ROUTE_OPTIONS = new Set(['csr', 'ssr', 'prerender', 'trailingSlash', 'config', 'entries']);

/**
 * Config-time shape check (when `ogygia()` is called): each entry is a plugin value — not the factory
 * itself — named once, with JSON options.
 */
export function check_plugins(plugins: unknown): OgygiaPlugin[] {
	if (plugins === undefined) return [];
	if (!Array.isArray(plugins)) throw new Error('[ogygia] `plugins` must be an array: `plugins: [flags()]`.');
	const seen = new Set<string>();
	for (const p of plugins as unknown[]) {
		if (typeof p === 'function')
			throw new Error('[ogygia] a plugin factory was passed uncalled — write `flags()`, not `flags`.');
		const plugin = p as Partial<OgygiaPlugin> | null;
		if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string' || plugin.name === '')
			throw new Error('[ogygia] each `plugins` entry must be a plugin (the value `definePlugin()` returns).');
		if (seen.has(plugin.name)) throw new Error(`[ogygia] plugin \`${plugin.name}\` is listed twice.`);
		seen.add(plugin.name);
		if (plugin.options !== undefined) {
			try {
				JSON.stringify(plugin.options);
			} catch {
				throw new Error(`[ogygia] plugin \`${plugin.name}\`: \`options\` must be plain JSON (configure live objects in hooks.server.ts).`);
			}
		}
	}
	return plugins as OgygiaPlugin[];
}

/** Does `<name>/<realm>` resolve from the app? Absent export: no such realm. A package the app cannot
 *  resolve at all is a mistake, said loudly. */
function realm_exists(req: NodeJS.Require, name: string, realm: string): boolean {
	try {
		req.resolve(`${name}/${realm}`);
		return true;
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'MODULE_NOT_FOUND') return false;
		throw e;
	}
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
 * When the app's root and mode are known (configResolved): order the plugins (`enforce`), find their
 * realms by name, run their `build` hooks. `markup_transform` is the configured compiler's island
 * transform for preprocessed markup (what `b.markup()` hands back).
 */
export function resolve_plugins(
	plugins: readonly OgygiaPlugin[],
	root: string,
	dev: boolean,
	markup_transform: MarkupIslands['transform'] = () => null
): ResolvedPlugins {
	const ordered = order(plugins);
	const req = createRequire(path.join(root, 'package.json'));
	const out: ResolvedPlugins = { servers: [], route_options: [], foreign_hydrate: false, macros: [], markup: [] };
	const option_owner = new Map<string, string>();
	const macro_owner = new Map<string, string>();
	for (const plugin of ordered) {
		if (!package_resolves(req, plugin.name))
			throw new Error(`[ogygia] plugin \`${plugin.name}\`: no package by that name resolves from ${root} — its name must be its package name.`);
		if (realm_exists(req, plugin.name, REALMS[0]))
			out.servers.push({ name: plugin.name, module: `${plugin.name}/server`, options: plugin.options ?? {} });
		plugin.build?.({
			root,
			dev,
			routeOption(name) {
				if (!ROUTE_OPTION_NAME_RE.test(name) || KIT_ROUTE_OPTIONS.has(name))
					throw new Error(`[ogygia] plugin \`${plugin.name}\`: route option \`${name}\` must be a camelCase identifier Kit does not own.`);
				const owner = option_owner.get(name);
				if (owner && owner !== plugin.name)
					throw new Error(`[ogygia] route option \`${name}\` is claimed by both \`${owner}\` and \`${plugin.name}\`.`);
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
					throw new Error(`[ogygia] plugin \`${plugin.name}\`: macro \`import.meta.og.${name}\` must be a camelCase name core does not own.`);
				const owner = macro_owner.get(name);
				if (owner)
					throw new Error(`[ogygia] macro \`import.meta.og.${name}\` is claimed by both \`${owner}\` and \`${plugin.name}\`.`);
				macro_owner.set(name, plugin.name);
				out.macros.push({ name, handler });
			},
			markup(source) {
				out.markup.push(source);
				return { transform: markup_transform };
			}
		});
	}
	return out;
}
