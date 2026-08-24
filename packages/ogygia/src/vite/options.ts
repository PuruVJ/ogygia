/**
 * Public options for the `ogygia` Vite plugin — one top-level key per subsystem, each
 * `defaults + its own presets`. Split out of the adapter so the plugin file stays lean; these are
 * pure type declarations (the plugin factory in index.ts imports them back).
 */
import type { ImportKeys } from '../compiler/region/transform.js';
import type { ProfilerOptions } from '../profiler/index.js';
import type { ContentPluginOptions } from '../content/vite/plugin.js';
import type { MarkdownOptions } from '../content/markdown/index.js';

/**
 * Named strategy bundle referenced from source via `with { preset: 'name' }`
 * (or the renamed `importKeys.preset` key).
 *
 * A preset speaks the SAME two-dial grammar as an inline import: `render` (the delivery mode) +
 * `wake` (the schedule), plus the tuning options that aren't allowed inline (`margin`, `maxAge`, …).
 */
export interface OgygiaPreset {
	/**
	 * Delivery mode (the `render` import attribute): `'static'` (default — an island that hydrates)
	 * | `'deferred'` (a hole whose HTML is fetched) | `'live'` (a hole that revalidates).
	 */
	render?: 'static' | 'deferred' | 'live';
	/**
	 * Schedule (the `wake` import attribute): hydration when `render` is `'static'`, the FETCH
	 * schedule when `'deferred'`/`'live'`. `'load'` | `'idle'` | `'visible'` | `'interaction'` |
	 * a CSS media query | `'none'` (a frozen lake).
	 */
	wake?: string;
	/** `IntersectionObserver` `rootMargin` when the schedule is `'visible'`. */
	margin?: string;
	/**
	 * `render: 'deferred'` — response cache max-age for the hole's HTML: seconds (number) or a
	 * duration string (`'30s'` | `'5m'` | `'1h'`). Absent or `0` → `no-store`: the hole is dynamic,
	 * re-rendered on every request. A positive value opts into a `private, max-age` browser cache.
	 * Signed into the hole's endpoint so a harvested URL can't be re-pointed at a longer cache.
	 *
	 * With `render: 'live'` this is instead the client revalidate staleness — use a duration string
	 * to stay unit-explicit across both.
	 */
	maxAge?: number | string;
	/** `render: 'live'` — past `maxAge`, whether to clear the hole (`'empty'`) or refetch (`'fetch'`). */
	onExpire?: 'empty' | 'fetch';
	/** `render: 'live'` — the revalidate schedule (`false` disables). Defaults to `wake`. */
	revalidate?: false | string;
	/** Continuity name (the `keep` import attribute): the live island relocates across SPA
	 *  navigation instead of remounting when the next page carries the same name. */
	keep?: string;
}

/** Per-IP budget for the signed deferred-region / lake-remount endpoint. */
export interface OgygiaRateLimit {
	/** Max requests per window (default `60`). `0` disables allowing any. */
	max?: number;
	/** Sliding window length in milliseconds (default `60_000`). */
	windowMs?: number;
}

/**
 * The `regions` subsystem — island defaults + the named preset dictionary. One grammar shared by
 * every subsystem: defaults at the root, variance in `presets`, referenced from a use site by a
 * LITERAL `preset: 'name'` (here: `import X from '…' with { preset: 'name' }`).
 */
export interface RegionsOptions {
	/**
	 * Global defaults for islands that use `wake: 'visible'` / `render`+`wake: 'visible'`
	 * without their own `margin` (via a preset).
	 */
	visible?: {
		/** Default `IntersectionObserver` `rootMargin` (e.g. `'200px'`). */
		margin?: string;
	};
	/**
	 * Named strategy bundles. Reference one from an import:
	 * `import Chart from '$lib/Chart.svelte' with { preset: 'chart' };`
	 */
	presets?: Record<string, OgygiaPreset>;
}

/**
 * A named CONTENT preset — a partial content-config referenced by a literal `preset: 'name'` on a
 * loader macro (`import.meta.og.loader.folder('../docs', { preset: 'name' })`). The referencing
 * collection's files compile as their own module VARIANTS (`?og_preset=name`), so the same file
 * used by another collection under another preset renders independently — never a conflict.
 */
export interface ContentPreset {
	/** Markdown options merged over `content.markdown` (per setting key — depth-2 replace). */
	markdown?: MarkdownOptions;
}

/**
 * Options for the {@link ogygia} Vite plugin — one top-level key per subsystem, each subsystem
 * `defaults + its own presets`.
 *
 * @example
 * ```ts
 * import { ogygia } from 'ogygia/vite';
 * export default defineConfig({
 *   plugins: [
 *     ogygia({
 *       regions: {
 *         visible: { margin: '200px' },
 *         presets: { chart: { wake: 'visible', margin: '200px' } }
 *       },
 *       regionTtl: 3600
 *     }),
 *     sveltekit()
 *   ]
 * });
 * ```
 */
export interface OgygiaOptions {
	/** The regions subsystem: island defaults (`visible.margin`) + named island presets. */
	regions?: RegionsOptions;

	/**
	 * Client-side SPA router — app-wide, on by default. It intercepts same-origin links, swaps
	 * `<body>`, merges `<head>`, and keeps `data-ogygia-keep` chrome across navigations. No component
	 * to place: the server handle injects the runtime + the `ogygia-router` meta into every page.
	 *
	 * - `true` (default) — router on, View Transitions on, form continuity on.
	 * - `false` — router off (the whole feature is tree-shaken out; same-origin links do full MPA
	 *   loads, and form continuity — which rides SPA navigation — goes with it).
	 * - `{ viewTransitions: false }` — router on, but no View Transitions API on navigation.
	 * - `{ forms: false }` — router on, but an island's half-filled form fields are NOT carried
	 *   across SPA navigation (continuity off).
	 * - `{ serverDelta: true }` — opt IN to server-delta nav: an SPA nav tells the server (via an
	 *   `x-ogygia-known` header) which islands it already has live, so the server SKIPS re-rendering
	 *   the unchanged ones and the client keeps them running. OFF by default (it is a new client↔server
	 *   protocol); when off the client never sends the header and the server always full-renders.
	 *
	 * Per-page escape hatch (no second config): a page opts *itself* out of View Transitions by
	 * emitting `<svelte:head><meta name="ogygia-router" content="plain" /></svelte:head>` — the handle
	 * injects the app default but a page that sets its own meta wins.
	 */
	router?: boolean | { viewTransitions?: boolean; forms?: boolean; serverDelta?: boolean };

	/**
	 * The content subsystem. `markdown` configures the mdsvex preprocessor (themes, remark plugins,
	 * heading ids…) — the defaults for every markdown file. `presets` are named variants a loader
	 * macro opts a whole collection into (`{ preset: 'name' }`); requires `markdown` to be set (the
	 * defaults are the base every preset merges over). The rest are dev HMR options.
	 */
	content?: ContentPluginOptions & {
		markdown?: MarkdownOptions;
		presets?: Record<string, ContentPreset>;
	};

	/**
	 * Rename the import-attribute keys claimed by the transform.
	 * Defaults stay `hydrate` / `defer` / `preset`. Escape hatch if another tool already
	 * uses those names on the same imports.
	 *
	 * Preset **definitions** ({@link RegionsOptions.presets}) still use canonical `hydrate` /
	 * `defer` / `margin` / `remount` — only the `with { … }` spellings in source change.
	 */
	importKeys?: Partial<ImportKeys>;

	/**
	 * The devtools EVENT LAYER (internal/notes/devtools.md). Off by default — user apps never ship it.
	 * Turn it on and the framework emits typed lifecycle events (island discovery, server render,
	 * wire crossings, client wake, hub mint/resolve, nav reconcile) keyed on the identities it already
	 * mints, which any sink (`ogygia/devtools`) can read: the REPL, a boundary-lens overlay, a bug-
	 * report trace, or our own event-driven e2e.
	 *
	 * - `false` (default) — the gate is off; every emit folds to `if (false)` and the bus tree-shakes
	 *   out of the runtime chunk. Zero cost.
	 * - `true` — emit on (dev or a prod build that asks for it, e.g. the REPL's prod switch).
	 */
	devtools?: boolean;

	/**
	 * Per-IP budget for the signed island endpoint served by `ogygiaHandle()`.
	 * Default `{ max: 60, windowMs: 60_000 }`. Pass `false` to disable.
	 */
	rateLimit?: false | OgygiaRateLimit;

	/**
	 * Cookie name to seal into the region MAC (opt-in). Empty/prerender stays unbound.
	 * Harvested capability URLs then fail verification without that cookie.
	 * Default `false` (unbound).
	 */
	sessionCookie?: false | string;

	/**
	 * Capability URL lifetime in seconds (default `3600`). Clamped to `[60, 86400]`.
	 * Keep short for harvested-URL risk; raise only if long-lived tabs must keep deferred holes valid.
	 */
	regionTtl?: number;

	/**
	 * The drop-in SSR profiler — configured ENTIRELY here, nowhere else. `true` (or an options object)
	 * turns it on: the plugin builds its UI (real Svelte islands, marked inside ogygia's own source and
	 * rendered only from its handle, so the client build can't otherwise see them) AND transports this
	 * config to `ogygia.handle()` via a virtual module. The handle dynamically imports and mounts the
	 * profiler itself — no `profiler()` in hooks, no handler wiring, and the profiler's weight loads only
	 * when it's on. The secret defaults to the `OGYGIA_PROFILER_SECRET` env var at runtime; pass
	 * `{ secret }` to override (baked into the server build). Off → no profiler at all.
	 */
	profiler?: boolean | ProfilerOptions;

	/**
	 * @internal Recreate this plugin instance inside the standalone client build.
	 * App authors should not set this.
	 */
	standalone?: boolean;
}

/**
 * The pre-v3 option spellings, killed by the config-surface collapse. Detected at config load and
 * answered with the exact new spelling — a rename map, never silent aliasing (a legacy key that
 * silently did nothing would un-tune real apps).
 */
const LEGACY_OPTION_RENAMES: Record<string, string> = {
	visible: '`visible` moved into the regions subsystem — write `regions: { visible: { … } }`.',
	presets: '`presets` moved into the regions subsystem — write `regions: { presets: { … } }`.',
	continuity:
		'`continuity` is gone — form continuity rides the router. Write `router: { forms: false }` to disable it.'
};

/** The v3 rename map: a legacy key errors with its new spelling, never silently no-ops. */
export function assert_no_legacy_options(options: OgygiaOptions): void {
	for (const key of Object.keys(LEGACY_OPTION_RENAMES)) {
		if (key in (options as Record<string, unknown>)) {
			throw new Error(`[ogygia] ${LEGACY_OPTION_RENAMES[key]}`);
		}
	}
}

const REGION_PRESET_KEYS = new Set([
	'render',
	'wake',
	'margin',
	'maxAge',
	'onExpire',
	'revalidate',
	'keep'
]);

/**
 * Config-time region-preset validation — the transform re-checks on USE (with file/line context), but
 * a broken preset nobody references yet should still fail the build, not lurk.
 */
export function validate_region_presets(presets: Record<string, unknown>): void {
	for (const [name, bag] of Object.entries(presets)) {
		if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) {
			throw new Error(
				`[ogygia] regions.presets.${name} is empty — a preset with nothing is a mistake.`
			);
		}
		for (const k of Object.keys(bag)) {
			if (!REGION_PRESET_KEYS.has(k)) {
				throw new Error(
					`[ogygia] regions.presets.${name}: unknown key \`${k}\`. A regions preset takes ${[...REGION_PRESET_KEYS].join(', ')}.`
				);
			}
		}
	}
}

/**
 * Config-time content-preset validation — closed vocabulary (only `markdown`), non-empty, identifier
 * names, and `content.markdown` required (the defaults are the base every preset merges over).
 */
export function validate_content_presets(
	content_presets: Record<string, unknown>,
	has_markdown: boolean
): void {
	if (!has_markdown) {
		throw new Error(
			'[ogygia] content.presets requires content.markdown — the defaults are the base every preset merges over (an empty `markdown: {}` is fine).'
		);
	}
	for (const [name, bag] of Object.entries(content_presets)) {
		if (!/^[\w-]+$/.test(name)) {
			throw new Error(
				`[ogygia] content.presets: '${name}' — preset names are identifiers ([A-Za-z0-9_-]).`
			);
		}
		if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) {
			throw new Error(
				`[ogygia] content.presets.${name} is empty — a preset with nothing is a mistake.`
			);
		}
		for (const k of Object.keys(bag)) {
			if (k !== 'markdown') {
				throw new Error(
					`[ogygia] content.presets.${name}: unknown key \`${k}\`. A content preset takes \`markdown\`.`
				);
			}
		}
	}
}

/** The router/capability config resolved from `OgygiaOptions` — pure derivation the factory reads. */
export interface ResolvedOgygiaConfig {
	rate_limit: { max: number; windowMs: number };
	session_cookie: string;
	region_ttl: number;
	router_enabled: boolean;
	router_view_transitions: boolean;
	continuity_forms: boolean;
	server_delta: boolean;
	devtools: boolean;
}

/**
 * Normalize the router / rate-limit / session / ttl / continuity / server-delta options into the flat
 * config the factory threads into `CompileCtx` + `Program`. Pure — no defaults leak back into `options`.
 * `defaultRegionTtl` is passed in (the endpoint's DEFAULT_REGION_TTL_SEC) to keep this Vite-free.
 */
export function resolve_options(
	options: OgygiaOptions,
	defaultRegionTtl: number
): ResolvedOgygiaConfig {
	// Region-endpoint rate limit (baked into SSR only via virtual:ogygia/rate-limit).
	const rate_limit =
		options.rateLimit === false
			? { max: 0, windowMs: 60_000 }
			: {
					max: Math.max(0, options.rateLimit?.max ?? 60),
					windowMs: Math.max(1, options.rateLimit?.windowMs ?? 60_000)
				};

	// Cookie name sealed into the region MAC, or '' when unbound (default).
	const session_cookie =
		typeof options.sessionCookie === 'string' && options.sessionCookie.length > 0
			? options.sessionCookie
			: '';

	// Capability URL TTL (seconds). Clamped to [60, 86400].
	const region_ttl = Math.min(
		86400,
		Math.max(60, Math.floor(options.regionTtl ?? defaultRegionTtl))
	);

	// ROUTER config (app-wide, one place). On by default; View Transitions on unless disabled. `false`
	// tree-shakes the whole feature out. Baked into `virtual:ogygia/router-config` for the handle.
	const router_enabled = options.router !== false;
	const router_view_transitions =
		options.router === false
			? false
			: typeof options.router === 'object'
				? options.router.viewTransitions !== false
				: true;

	// CONTINUITY rides the router (it snapshots on SPA navigation): router on + `forms` not disabled.
	// `router: false` takes forms with it — there is no SPA nav to survive.
	const continuity_forms =
		router_enabled && (typeof options.router === 'object' ? options.router.forms !== false : true);

	// SERVER-DELTA NAV is opt-in (a new client↔server protocol). Only when the router is on AND the app
	// explicitly writes `router: { serverDelta: true }`. Off → the client never sends `x-ogygia-known`,
	// so the server always full-renders (safe fallback). Server-delta needs SPA nav, so router-off ⇒ off.
	const server_delta =
		router_enabled && typeof options.router === 'object' && options.router.serverDelta === true;

	// DEVTOOLS event layer — off unless the app opts in. Independent of the router (client AND server
	// realms emit); a plain `true` turns the compile gate on for both dev and this build's output.
	const devtools = options.devtools === true;

	return {
		rate_limit,
		session_cookie,
		region_ttl,
		router_enabled,
		router_view_transitions,
		continuity_forms,
		server_delta,
		devtools
	};
}
