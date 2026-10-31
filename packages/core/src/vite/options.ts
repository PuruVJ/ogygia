/**
 * Public options for the `ogygia` Vite plugin — one top-level key per subsystem, each
 * `defaults + its own presets`. Split out of the adapter so the plugin file stays lean; these are
 * pure type declarations (the plugin factory in index.ts imports them back).
 */
import type { ImportKeys } from '../compiler/region/transform.ts';
import type { DebarrelOptions } from '../compiler/debarrel/options.ts';

// ── regexes

/**
 * Named strategy bundle referenced from source via `with { preset: 'name' }`
 * (or the renamed `importKeys.preset` key).
 *
 * A preset speaks the SAME grammar as an inline import: a `render` mode with its timing (`fetch` for
 * a `deferred` hole, `wake` for an island), plus the tuning options that aren't allowed inline
 * (`margin`, `maxAge`, …).
 */
export interface OgygiaPreset {
	/**
	 * Delivery mode (the `render` import attribute): `'static'` (default — an island that hydrates)
	 * | `'deferred'` (a hole whose HTML is fetched, on its `fetch` timing) | `'live'` (a hole that
	 * revalidates).
	 */
	render?: 'static' | 'deferred' | 'live';
	/**
	 * When an island's JS runs (the `wake` import attribute): `'load'` | `'idle'` | `'visible'` |
	 * `'interaction'` | a CSS media query | `'none'` (a frozen lake). With `render: 'live'`, the
	 * revalidate schedule. Never a `deferred` hole's timing — that is `fetch`.
	 */
	wake?: string;
	/**
	 * A `render: 'deferred'` hole's timing — when its HTML arrives (the `fetch` import attribute):
	 * `'load'` (default) | `'idle'` | `'visible'` | `'interaction'` | a CSS media query.
	 */
	fetch?: string;
	/** `IntersectionObserver` `rootMargin` when the schedule is `'visible'`. */
	margin?: string;
	/**
	 * A hole (`fetch`) — response cache max-age for the hole's HTML: seconds (number) or a
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
	/**
	 * A hole (`fetch`) — warm the hole's HTML into the frame store on this schedule (`'load'` |
	 * `'idle'` | `'visible'` | a media query) while `fetch` still decides when it swaps in. An
	 * on-demand hole (`fetch: 'interaction'`) then has its bytes before the first hover: the gesture
	 * joins the warm frame instead of paying the origin round trip. Never `'interaction'` — that is
	 * the swap schedule, `fetch`'s job.
	 */
	prefetch?: string;
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
 * Options for the {@link ogygia} Vite plugin. The root is the region system itself — its defaults
 * (`visible`), its named presets (referenced from a use site by a LITERAL `preset: 'name'`:
 * `import X from '…' with { preset: 'name' }`), its holes' capability lifetimes — beside the client
 * router. Feature packages are Vite plugins listed beside it (`plugins: [ogygia(), flags(), sveltekit()]`).
 *
 * @example
 * ```ts
 * import { ogygia } from 'ogygia/vite';
 * export default defineConfig({
 *   plugins: [
 *     ogygia({
 *       visible: { margin: '200px' },
 *       presets: { chart: { wake: 'visible', margin: '200px' } },
 *       ttl: 3600
 *     }),
 *     sveltekit()
 *   ]
 * });
 * ```
 */
export interface OgygiaOptions {
	/**
	 * Defaults for regions that wake `'visible'` (`wake: 'visible'` / `render` + `wake: 'visible'`)
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
	/**
	 * How long a deferred/live hole's signed capability URL stays valid, in seconds (default `3600`).
	 * Clamped to `[60, 86400]`. Keep short for harvested-URL risk. Holes outlive this automatically
	 * where they must: on prerendered and frozen pages, and on a page a load marks shared-cacheable
	 * (`setHeaders({ 'cache-control': 'public, s-maxage=…' })`), where an anonymous hole is signed for
	 * the page's cache life; a hole on an older cached copy renews itself when it wakes.
	 */
	ttl?: number;
	/**
	 * The oldest a cached copy of a page can be and still get its holes, in seconds (default
	 * `691200`, 8 days). An anonymous hole whose capability expired while a cache kept its page
	 * renews itself for up to this long after that expiry; past it, the hole keeps its fallback.
	 * Raise it to the longest your CDN may serve a page when the page does not say so in its
	 * `cache-control`. `0` turns renewal off. Unlike `ttl` it never lengthens a hole URL's life (a
	 * renewed URL lives `ttl`), and a hole bound to a session never renews. A renewable URL replays its
	 * props: keep hole props to routing keys (a locale, a page), and read anything sensitive at render.
	 */
	maxPageAge?: number;

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
	 * Rename the import-attribute keys claimed by the transform.
	 * Defaults stay `hydrate` / `defer` / `preset`. Escape hatch if another tool already
	 * uses those names on the same imports.
	 *
	 * Preset **definitions** ({@link OgygiaOptions.presets}) still use canonical `hydrate` /
	 * `defer` / `margin` / `remount` — only the `with { … }` spellings in source change.
	 */
	importKeys?: Partial<ImportKeys>;

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
	 * Barrel imports become leaf imports at transform time — `import { Button } from '$lib'` (an
	 * `index.ts` that re-exports forty files) becomes `import Button from '…/Button.svelte'`, so the
	 * module graph (dev) and the chunk graph (build) hold only the leaves a file uses.
	 *
	 * - `true` — every PURE barrel in the project (outside `node_modules`) is bypassed.
	 * - `{ packages, force, keep, … }` — opt dependencies in, force impure barrels, keep some.
	 *
	 * Independent of islands: an import that carries region marks (`with { wake }` …) is never
	 * rewritten — a barrel binding is marked through `asRegion` or a mark in the barrel, as before.
	 * The same plugin is `debarrel()` from `'ogygia/vite'` for any Vite app.
	 */
	barrels?: boolean | DebarrelOptions;

	/**
	 * @internal Recreate this plugin instance inside the standalone client build.
	 * App authors should not set this.
	 */
	standalone?: boolean;
}

/**
 * Retired option spellings. Detected at config load and answered with the exact new spelling — a
 * rename map, never silent aliasing (a legacy key that silently did nothing would un-tune real apps).
 */
const LEGACY_OPTION_RENAMES: Record<string, string> = {
	regions:
		'`regions` is gone — its keys sit at the root now: write `visible`, `presets`, `ttl` and `maxPageAge` directly in `ogygia({ … })`.',
	continuity:
		'`continuity` is gone — form continuity rides the router. Write `router: { forms: false }` to disable it.',
	regionTtl: '`regionTtl` is `ttl` now — write `ogygia({ ttl: … })`.',
	preload:
		'`preload` is gone — there is nothing to choose any more. The page carries each island’s chunk list as data, and the runtime preloads an island’s whole graph when it wakes (after the page has painted), so no island code moves before its wake and none waits on a waterfall after it. Remove the key.',
	plugins:
		'`plugins` is gone — ogygia plugins are Vite plugins: list them beside `ogygia()` in vite.config, `plugins: [ogygia(), flags(), sveltekit()]`.',
	freeze:
		'`freeze` is a plugin now — install `@ogygia/freeze` and list `freeze({ ttl, default })` (from `@ogygia/freeze/vite`) beside `ogygia()` in vite.config `plugins`.',
	content:
		'`content` is a plugin now — install `@ogygia/content` and list `content({ markdown, presets })` (from `@ogygia/content/vite`) beside `ogygia()` in vite.config `plugins`; the svelte config takes `preprocess()` / `extensions()` from there too.',
	devtools:
		"`devtools` is a plugin now — install `@ogygia/devtools` and list `devtools()` (from `@ogygia/devtools/vite`) beside `ogygia()` in vite.config `plugins`; only where you want it, e.g. `...(mode !== 'production' ? [devtools()] : [])`.",
	profiler:
		'`profiler` is part of the devtools plugin now — install `@ogygia/devtools` and list `devtools({ profiler: { … } })` (from `@ogygia/devtools/vite`) beside `ogygia()` in vite.config `plugins`.'
};

/** The rename map: a legacy key errors with its new spelling, never silently no-ops. */
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
	'fetch',
	'margin',
	'maxAge',
	'onExpire',
	'revalidate',
	'keep',
	'stitch',
	'prefetch'
]);

/**
 * Config-time region-preset validation — the transform re-checks on USE (with file/line context), but
 * a broken preset nobody references yet should still fail the build, not lurk.
 */
export function validate_region_presets(presets: Record<string, unknown>): void {
	for (const [name, bag] of Object.entries(presets)) {
		if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) {
			throw new Error(`[ogygia] presets.${name} is empty — a preset with nothing is a mistake.`);
		}
		for (const k of Object.keys(bag)) {
			if (!REGION_PRESET_KEYS.has(k)) {
				throw new Error(
					`[ogygia] presets.${name}: unknown key \`${k}\`. A preset takes ${[...REGION_PRESET_KEYS].join(', ')}.`
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
	renew_window: number;
	router_enabled: boolean;
	router_view_transitions: boolean;
	continuity_forms: boolean;
	server_delta: boolean;
}

/**
 * Normalize the router / rate-limit / session / ttl / continuity / server-delta options into the flat
 * config the factory threads into `CompileCtx` + `Program`. Pure — no defaults leak back into `options`.
 * `defaultRegionTtl` / `defaultRenewWindow` are passed in (the endpoint's DEFAULT_REGION_TTL_SEC,
 * shared-cache's RENEW_WINDOW_SEC) to keep this Vite-free.
 */
export function resolve_options(
	options: OgygiaOptions,
	defaultRegionTtl: number,
	defaultRenewWindow: number = 8 * 24 * 3600
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
	const region_ttl = Math.min(86400, Math.max(60, Math.floor(options.ttl ?? defaultRegionTtl)));

	// Renewal window (seconds) after a capability expired: `maxPageAge`. `0` = never renew; at most 10
	// years (the prerender capability life — nothing outlives that).
	const renew_raw = options.maxPageAge;
	if (
		renew_raw !== undefined &&
		!(typeof renew_raw === 'number' && Number.isFinite(renew_raw) && renew_raw >= 0)
	) {
		throw new Error(
			`[ogygia] maxPageAge must be a number of seconds ≥ 0 (got ${String(renew_raw)}). Write e.g. \`30 * 24 * 3600\` for 30 days, or \`0\` to turn renewal off.`
		);
	}
	const renew_window = Math.min(10 * 365 * 24 * 3600, Math.floor(renew_raw ?? defaultRenewWindow));

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

	return {
		rate_limit,
		session_cookie,
		region_ttl,
		renew_window,
		router_enabled,
		router_view_transitions,
		continuity_forms,
		server_delta
	};
}
