/**
 * Public options for the `ogygia` Vite plugin — one top-level key per subsystem, each
 * `defaults + its own presets`. Split out of the adapter so the plugin file stays lean; these are
 * pure type declarations (the plugin factory in index.ts imports them back).
 */
import type { ImportKeys } from '../compiler/region/transform.js';
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
	content?: ContentPluginOptions & { markdown?: MarkdownOptions; presets?: Record<string, ContentPreset> };

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
	 * @internal Recreate this plugin instance inside the standalone client build.
	 * App authors should not set this.
	 */
	standalone?: boolean;
}
