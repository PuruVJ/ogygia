import { fs, path } from './host.js';
import { createRequire } from 'node:module';
import { ISLAND_DIR } from './region/transform.js';

/** The Kit-internal + app paths ogygia deep-imports (resolved off the APP root, not this package). */
export interface KitPaths {
	/** Kit's internal wire-protocol module (deep import), or null → built-in devalue codec fallback. */
	kit_wire_path: string | null;
	/** Kit's client remote-functions entry (Plan A reuse), or null. */
	kit_remote_index: string | null;
	/** The app's universal hooks (`src/hooks.{ts,js}`) for `transport`, or null when absent. */
	universal_hooks: string | null;
}

/**
 * Locate Kit's internal wire-protocol + client remote-functions modules by resolving `@sveltejs/kit`'s
 * package.json (that IS exported) and joining the src path — deep-importing the file bypasses the exports
 * map. Also finds the app's universal hooks. Resolved from the APP root (`createRequire` off a root path),
 * so a monorepo sub-package still finds Kit. Never throws (a missing Kit → the devalue-codec fallback).
 */
export function resolve_kit_paths(root: string): KitPaths {
	let kit_wire_path: string | null = null;
	let kit_remote_index: string | null = null;
	let universal_hooks: string | null = null;
	try {
		const require = createRequire(path.join(root, 'noop.js'));
		const kitRoot = path.dirname(require.resolve('@sveltejs/kit/package.json'));
		const candidate = path.join(kitRoot, 'src', 'runtime', 'shared.js');
		if (fs.existsSync(candidate)) kit_wire_path = candidate;
		const remoteIdx = path.join(
			kitRoot,
			'src',
			'runtime',
			'client',
			'remote-functions',
			'index.js'
		);
		if (fs.existsSync(remoteIdx)) kit_remote_index = remoteIdx;
	} catch {
		kit_wire_path = null; // fall back to the built-in devalue codec (no transport)
	}
	// the app's universal hooks (default src/hooks.{ts,js}) for `transport`
	for (const f of ['hooks.ts', 'hooks.js']) {
		const abs = path.join(root, 'src', f);
		if (fs.existsSync(abs)) {
			universal_hooks = abs;
			break;
		}
	}
	return { kit_wire_path, kit_remote_index, universal_hooks };
}

// ─────────────────────────────────────────────────────────────────────────────
// csr detection.
//
// When every route NODE is csr=false, Kit skips its client build entirely, so the ogygia runtime chunk
// is never emitted and the SSR'd `<script src>` 404s. ogygia fixes this transparently: during a build,
// the plugin injects a URL-less keepalive layout (`src/routes/.ogygia-keep-client/+layout.ts`, a single
// `csr = true` node) that keeps Kit building the client, then removes it at process exit — nothing is
// committed and no Kit internal is consulted (see index.ts). `clientBuildWillSkip` (ignoring that
// injected dir) drives WHEN to inject; `hasAnyCsrFalseRoute` drives the "pure csr=true app ships zero
// ogygia" runtime gate.
// ─────────────────────────────────────────────────────────────────────────────

const CSR_EXPORT = /export\s+const\s+csr(?:\s*:\s*boolean)?\s*=\s*(true|false)/;
const FREEZE_EXPORT = /export\s+const\s+freeze(?:\s*:\s*boolean)?\s*=\s*(true|false)/;
// Strip form (global): a route option file's `export const freeze = …` is REMOVED before Kit
// sees the module — Kit's export validators reject any non-Kit page export. Length-preserving
// (blanked to a same-length comment) so byte offsets — and source maps — are untouched.
const FREEZE_EXPORT_STRIP_G =
	/export\s+const\s+freeze(?:\s*:\s*boolean)?\s*=\s*(?:true|false)\s*;?/g;
const OPTION_FILE_RE = /(?:^|[/\\])\+(?:page|layout)(?:\.server)?\.(?:js|ts)$/;
// Comment strippers shared by the option-file readers: a COMMENTED-OUT `export const csr|freeze`
// must never win the first-match read. Block comments, plus WHOLE-LINE `//` only (a partial-line
// `//` is left so it can't eat a `://` inside a string; a trailing comment can't flip the reading).
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_G = /^[ \t]*\/\/.*$/gm;

/** Read `export const csr = true|false` from a route options file; `undefined` if unset/absent. */
export function read_csr(file: string) {
	try {
		let src = fs.readFileSync(file, 'utf-8');
		// Strip comments so a COMMENTED-OUT `export const csr = …` never wins the (first-match) regex —
		// e.g. a stale `// export const csr = true` above a real `export const csr = false` would
		// otherwise read `true` and make ogygia strip islands from a page Kit renders csr=false. Block
		// comments, plus WHOLE-LINE `//` comments only (a partial-line `//` is left so it can't eat a
		// `://` inside a string; a trailing comment can't flip the reading — the real export matches first).
		src = src.replace(BLOCK_COMMENT_G, '').replace(LINE_COMMENT_G, '');
		const m = CSR_EXPORT.exec(src);
		return m ? m[1] === 'true' : undefined;
	} catch {
		return undefined;
	}
}

/** Read `export const freeze = true|false` from a route options file; `undefined` if unset/absent.
 *  Same comment-stripping as {@link read_csr} so a commented-out declaration never wins. */
export function read_freeze(file: string): boolean | undefined {
	try {
		let src = fs.readFileSync(file, 'utf-8');
		src = src.replace(BLOCK_COMMENT_G, '').replace(LINE_COMMENT_G, '');
		const m = FREEZE_EXPORT.exec(src);
		return m ? m[1] === 'true' : undefined;
	} catch {
		return undefined;
	}
}

/** True for a route option file (`+page(.server).{js,ts}` / `+layout(.server).{js,ts}`) under
 *  `routesDir` — where an `export const freeze` may live and must be stripped before Kit. */
export function is_route_option_file(id: string, routesDir: string): boolean {
	const clean = id.split('?')[0];
	return clean.startsWith(routesDir) && OPTION_FILE_RE.test(clean);
}

/** Remove `export const freeze = true|false` from a route option file's source (length-preserving),
 *  so Kit's export validators never see the non-Kit page export. The VALUE is read from disk
 *  separately ({@link read_freeze} / {@link freezeRouteIds}); this only keeps Kit from choking. */
export function strip_freeze_export(code: string): string {
	if (!code.includes('freeze')) return code; // cheap out — the common file has none
	return code.replace(FREEZE_EXPORT_STRIP_G, (m) =>
		m.length >= 4 ? '/*' + ' '.repeat(m.length - 4) + '*/' : ' '.repeat(m.length)
	);
}

const OPTION_FILES_PAGE = ['+page.js', '+page.ts', '+page.server.js', '+page.server.ts'];
const OPTION_FILES_LAYOUT = ['+layout.js', '+layout.ts', '+layout.server.js', '+layout.server.ts'];

/**
 * Own-chain Kit-effective `csr === false` for one route host — Kit's per-PAGE rule verbatim:
 * walk the layout option files root → host dir (then the page's own option files), deepest
 * declaration wins. `undefined` in sources means Kit's default (`true`).
 */
function own_chain_csr_false(hostFile: string, routesDir: string) {
	let csr; // undefined => Kit default (true)
	const dir = path.dirname(hostFile);
	const rel = path.relative(routesDir, dir);
	const parts = rel ? rel.split(path.sep) : [];
	let cur = routesDir;
	const chain = [cur];
	for (const p of parts) {
		cur = path.join(cur, p);
		chain.push(cur);
	}
	for (const d of chain) {
		for (const f of OPTION_FILES_LAYOUT) {
			const v = read_csr(path.join(d, f));
			if (v !== undefined) csr = v;
		}
	}
	if (path.basename(hostFile) === '+page.svelte') {
		for (const f of OPTION_FILES_PAGE) {
			const v = read_csr(path.join(dir, f));
			if (v !== undefined) csr = v;
		}
	}
	return csr === false;
}

// ── PAGE-CSR invariant (see internal/notes/INVARIANTS.md) ────────────────────────────────────
// ONE source of truth for csr topology: every `+page.svelte` leaf's Kit-effective csr, computed
// with Kit's own rule (option-file chain, deepest wins — layout criss-crossing included), walked
// ONCE per routesDir and memoized. Everything else DERIVES from this map:
//   · a PAGE host's world = its own entry;
//   · a LAYOUT host has NO world of its own — it serves the pages at/below its dir
//     (all csr=true → Kit hydrates everywhere, strip; all csr=false → island world;
//      mixed → shared world: keep islands, the runtime degrades per document);
//   · the runtime `csr_true_routes` set = the map's csr=true entries.
// Judging a layout by its own partial chain is the bug this exists to prevent: `csr = false`
// declared BELOW the root layout used to flip the root chrome into the strip path while Kit
// shipped no client for those pages — dead Header/BootEffects.
const _page_worlds = new Map<string, Map<string, boolean>>(); // routesDir → (pageDir → csrIsFalse)

function page_worlds(routesDir: string): Map<string, boolean> {
	let m = _page_worlds.get(routesDir);
	if (!m) {
		m = new Map();
		for (const page of pageLeaves(routesDir))
			m.set(path.dirname(page), own_chain_csr_false(page, routesDir));
		_page_worlds.set(routesDir, m);
	}
	return m;
}

/** The worlds of the pages a layout serves (its dir + everything below). */
function layout_page_worlds(layoutDir: string, routesDir: string) {
	let any_false = false;
	let any_true = false;
	const prefix = layoutDir + path.sep;
	for (const [dir, is_false] of page_worlds(routesDir)) {
		if (dir !== layoutDir && !dir.startsWith(prefix)) continue;
		if (is_false) any_false = true;
		else any_true = true;
	}
	return { any_false, any_true };
}

/**
 * Kit-effective `csr === false` for a `+page.svelte` / `+layout.svelte` host. Pages use Kit's
 * own-chain rule; a LAYOUT is csr=false exactly when EVERY page it serves is csr=false (a layout
 * with no pages below — endpoint-only subtree — falls back to its own chain).
 * @param hostFile abs path to a route `.svelte`
 * @param routesDir abs `src/routes`
 */
export function routeCsrIsFalse(hostFile: string, routesDir: string) {
	if (!hostFile.startsWith(routesDir)) return false;
	const base = path.basename(hostFile);
	if (base === '+page.svelte') return own_chain_csr_false(hostFile, routesDir);
	if (base !== '+layout.svelte') return false;
	const { any_false, any_true } = layout_page_worlds(path.dirname(hostFile), routesDir);
	if (any_false && !any_true) return true; // every page it serves is csr=false
	if (any_false || any_true) return false; // mixed (or pure-true) → not the false world
	return own_chain_csr_false(hostFile, routesDir); // no pages below — own chain
}

/**
 * True when `hostFile` is a route host whose islands ogygia must STRIP (Kit hydrates every page
 * this host serves). Pages: Kit's own-chain rule (default true, or an explicit `csr = true` that
 * beats a `false` up the chain). LAYOUTS: strippable ONLY when no page at/below them is
 * csr=false — on a mixed layout both this and {@link routeCsrIsFalse} are false (shared world:
 * islands kept, `documentIsCsrTrue` degrades them per document). `false` for non-route files
 * (shared components): their csr depends on which page renders them, so they keep their islands.
 */
export function routeCsrIsTrue(hostFile: string, routesDir: string) {
	const base = path.basename(hostFile);
	if (base !== '+page.svelte' && base !== '+layout.svelte') return false;
	if (!hostFile.startsWith(routesDir)) return false;
	if (base === '+page.svelte') return !own_chain_csr_false(hostFile, routesDir);
	const { any_false, any_true } = layout_page_worlds(path.dirname(hostFile), routesDir);
	if (any_false) return false; // some page below gets no Kit client — never strip its chrome
	if (any_true) return true; // every page below is Kit-hydrated
	return !own_chain_csr_false(hostFile, routesDir); // no pages below — own chain
}

function pageLeaves(routesDir: string) {
	const leaves: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name === '+page.svelte') leaves.push(full);
		}
	};
	walk(routesDir);
	return leaves;
}

/** Kit's `route.id` for a page host, with layout GROUP segments (`(app)`) stripped — the same
 *  normalization {@link csrTrueRouteIds} applies, so the two sides match whether or not Kit keeps
 *  groups in `route.id`. Root → `/`. */
export function normalize_route_id(id: string): string {
	const segs = id
		.split('/')
		.filter(Boolean)
		.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segs.join('/');
}

/**
 * The set of route ids (Kit `route.id`, group-stripped) whose EFFECTIVE csr is TRUE — i.e. Kit
 * hydrates the whole document there. A csr=false layout's islands rendered under one of these must
 * degrade to inline on BOTH legs (Kit owns hydration); Region reads this map on the server, and
 * `kit_hydrates_page()` is the identical client signal. Empty for a fully csr=false app (the norm);
 * only the csr=true exceptions land here.
 */
export function csrTrueRouteIds(routesDir: string): string[] {
	const ids = new Set<string>();
	// Derived from the SAME per-page map the compile-side world decisions use (PAGE-CSR invariant).
	for (const [dir, is_false] of page_worlds(routesDir)) {
		if (is_false) continue; // Kit does NOT hydrate → keep islands
		const rel = path.relative(routesDir, dir);
		const raw = '/' + (rel ? rel.split(path.sep).join('/') : '');
		ids.add(normalize_route_id(raw));
	}
	return [...ids];
}

// ── FREEZE opt-in (per-route / per-layout) ────────────────────────────────────────────────
// `export const freeze = true|false` in a page/layout option file marks a route in or out of the
// render-on-write store, using Kit's OWN cascade rule (option-file chain, deepest declaration wins,
// layouts included — the same walk `csr` uses). The config `default` fills an unset route: `true`
// keeps today's auto-by-observed-purity behaviour (opt OUT with `= false`); `false` is opt-in
// (nothing stores unless a route/layout sets `= true`). Opt-in only makes a page ELIGIBLE — the
// observed-purity check still refuses an impure render. Memoized per routesDir; cleared on a dev
// route-topology change alongside the csr maps.
const _page_freeze = new Map<string, Map<string, boolean | undefined>>();

// A `+page.*` file: svelte host, universal, OR server — a route dir with ANY of these produces a
// page RESPONSE. Unlike csr (which is about hydrating a rendered `+page.svelte`), a frozen page can
// store a redirect-only route (a `+page.server.ts` that throws `redirect()`, no `+page.svelte`), so
// the freeze enumeration must include those too.
const PAGE_FILE_RE = /^\+page(\.server)?\.(svelte|js|ts)$/;

/** Every route dir with a `+page.*` file — a route that produces a page response (rendered HTML or
 *  a stored redirect). Broader than {@link pageLeaves} (svelte-only) on purpose. */
function freeze_page_dirs(routesDir: string): string[] {
	const dirs = new Set<string>();
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (PAGE_FILE_RE.test(e.name)) dirs.add(dir);
		}
	};
	walk(routesDir);
	return [...dirs];
}

/** Own-chain effective `freeze` for one page DIR — deepest-wins over the layout chain (root →
 *  the dir, its own `+layout` included) then the page's own option files. `undefined` = no
 *  declaration anywhere (use the config default). */
function own_chain_freeze(pageDir: string, routesDir: string): boolean | undefined {
	let val: boolean | undefined;
	const rel = path.relative(routesDir, pageDir);
	const parts = rel ? rel.split(path.sep) : [];
	let cur = routesDir;
	const chain = [cur];
	for (const p of parts) {
		cur = path.join(cur, p);
		chain.push(cur);
	}
	for (const d of chain) {
		for (const f of OPTION_FILES_LAYOUT) {
			const v = read_freeze(path.join(d, f));
			if (v !== undefined) val = v;
		}
	}
	for (const f of OPTION_FILES_PAGE) {
		const v = read_freeze(path.join(pageDir, f));
		if (v !== undefined) val = v;
	}
	return val;
}

function page_freeze(routesDir: string): Map<string, boolean | undefined> {
	let m = _page_freeze.get(routesDir);
	if (!m) {
		m = new Map();
		for (const dir of freeze_page_dirs(routesDir)) m.set(dir, own_chain_freeze(dir, routesDir));
		_page_freeze.set(routesDir, m);
	}
	return m;
}

/** A page directory's Kit `route.id`, group-stripped (`normalize_route_id`). */
function page_route_id(dir: string, routesDir: string): string {
	const rel = path.relative(routesDir, dir);
	return normalize_route_id('/' + (rel ? rel.split(path.sep).join('/') : ''));
}

/** Route ids (Kit `route.id`, group-stripped) whose EFFECTIVE freeze opt-in is TRUE, given the
 *  config `default`. The handle gates the render-on-write store/serve path on membership. */
export function freezeRouteIds(routesDir: string, defaultOn: boolean): string[] {
	const ids = new Set<string>();
	for (const [dir, eff] of page_freeze(routesDir)) {
		if ((eff ?? defaultOn) === true) ids.add(page_route_id(dir, routesDir));
	}
	return [...ids];
}

/** EVERY page route id (group-stripped), opted in or not. The handle uses membership to tell "a
 *  Kit page whose cascaded value is false" from "not a page at all" (an endpoint route, or a
 *  request no file route claimed) — the latter fall back to the config `default`. */
export function pageRouteIds(routesDir: string): string[] {
	const ids = new Set<string>();
	for (const dir of page_freeze(routesDir).keys()) ids.add(page_route_id(dir, routesDir));
	return [...ids];
}

// Memoized per routesDir — a build-constant walked once, not per-transform. Dev route-topology
// changes clear it via `clear_route_csr_cache` (the plugin's route watcher).
const _has_csr_true = new Map<string, boolean>();

/**
 * Does the app have ANY csr=true page (Kit hydrates the whole document there)? Drives whether a
 * csr=false LAYOUT must link its island wrapper on the CLIENT leg: on a csr=true child page Kit
 * hydrates the layout, so its chrome islands must be REAL wrappers (Region degrades them inline),
 * not the thin stub the pure-csr=false path uses. A pure-csr=false app keeps the stub (thin client
 * graph); only mixed apps pay for the layout wrappers.
 */
export function hasAnyCsrTrueRoute(routesDir: string): boolean {
	let v = _has_csr_true.get(routesDir);
	if (v === undefined) {
		v = csrTrueRouteIds(routesDir).length > 0;
		_has_csr_true.set(routesDir, v);
	}
	return v;
}

/** Drop the memoized csr-topology answers (a route/`csr`-export add/remove invalidates them). */
export function clear_route_csr_cache(): void {
	_has_csr_true.clear();
	_page_worlds.clear();
	_page_freeze.clear();
}

// The build-time keepalive route ogygia injects to defeat Kit's skip (see index.ts). It must be
// invisible to the skip detection itself — otherwise its own csr=true node would mask whether the
// USER's real routes are all csr=false.
export const KEEP_CLIENT_DIR = '.ogygia-keep-client';

const PAGE_UNIVERSAL = ['+page.js', '+page.ts'];
const PAGE_SERVER = ['+page.server.js', '+page.server.ts'];
const LAYOUT_UNIVERSAL = ['+layout.js', '+layout.ts'];
const LAYOUT_SERVER = ['+layout.server.js', '+layout.server.ts'];

/** A node's OWN csr (server module then universal wins), independent of the layout chain. */
function own_csr(dir: string, universal: string[], server: string[]) {
	let csr; // undefined = not set on this node
	for (const f of server) {
		const v = read_csr(path.join(dir, f));
		if (v !== undefined) csr = v;
	}
	for (const f of universal) {
		const v = read_csr(path.join(dir, f));
		if (v !== undefined) csr = v;
	}
	return csr;
}

/**
 * Collects every route node's EFFECTIVE csr the way Kit does — a node exists per `+page` and per
 * `+layout` (component OR standalone module), and Kit's static analysis resolves each node's
 * `page_options` through the LAYOUT CHAIN (`page_options = { ...parent_options, ...own }`), so a
 * root-layout `csr = false` makes every option-less descendant node `csr === false` too. Layout
 * groups like `(ogygia)/+layout.ts` count too.
 *
 * Issue #4/#1 root cause lived here: reading each node's OWN csr only, a fresh app with `csr =
 * false` in nothing but the root layout looked like "client build runs" (pages read `undefined`),
 * so the keepalive was never injected — while Kit, resolving the chain, skipped the client build
 * and the runtime `<script src>` 404'd.
 * @returns one entry per node (undefined = unset anywhere up-chain)
 */
function collectNodeEffectiveCsr(routesDir: string) {
	const nodes = [];
	let saw_root_layout = false;
	const walk = (dir: string, is_root: boolean, inherited: boolean | undefined) => {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
		const has = (list: string[]) => list.some((f) => names.has(f));

		// This dir's layout value carries down the chain whether or not a layout NODE exists here
		// (Kit merges parent options first; a dir with only `+layout.ts` still re-scopes children).
		const layout_own = own_csr(dir, LAYOUT_UNIVERSAL, LAYOUT_SERVER);
		const chain = layout_own !== undefined ? layout_own : inherited;

		// layout node: +layout.svelte, +layout.js/ts, or +layout.server.js/ts
		if (names.has('+layout.svelte') || has(LAYOUT_UNIVERSAL) || has(LAYOUT_SERVER)) {
			if (is_root) saw_root_layout = true;
			nodes.push(chain);
		}
		// page node: +page.svelte, +page.js/ts, or +page.server.js/ts
		if (names.has('+page.svelte') || has(PAGE_UNIVERSAL) || has(PAGE_SERVER)) {
			const page_own = own_csr(dir, PAGE_UNIVERSAL, PAGE_SERVER);
			nodes.push(page_own !== undefined ? page_own : chain);
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name === KEEP_CLIENT_DIR) continue; // ignore our own injected keepalive
			walk(path.join(dir, e.name), false, chain);
		}
	};
	walk(routesDir, true, undefined);
	// Kit always synthesizes a root layout node; if the app has none, it carries null options
	// (csr unset) — which alone is enough to keep the client build alive.
	if (!saw_root_layout) nodes.push(undefined);
	return nodes;
}

/**
 * Replicates Kit's `manifest_data.nodes.every(n => n.page_options?.csr === false)` — the exact
 * condition under which Kit skips the client build — with `page_options` CHAIN-RESOLVED exactly as
 * Kit's static analysis resolves it. A single node whose effective csr is `true` or simply unset
 * keeps the build alive. When this is true, ogygia's runtime is never emitted, so index.ts injects
 * the keepalive. Deviations (a `+page@` reset, a statically-unanalysable option file) can only err
 * toward injecting a keepalive Kit didn't need — a harmless extra client build, never a 404.
 */
export function clientBuildWillSkip(routesDir: string) {
	if (!fs.existsSync(routesDir)) return false;
	const nodes = collectNodeEffectiveCsr(routesDir);
	if (nodes.length === 0) return false;
	return nodes.every((csr) => csr === false);
}

/**
 * True when AT LEAST ONE page route is csr=false. A pure csr=true app (this returns false) needs no
 * ogygia runtime at all — Kit hydrates everything itself — so the runtime chunk is skipped entirely.
 */
export function hasAnyCsrFalseRoute(routesDir: string) {
	if (!fs.existsSync(routesDir)) return false;
	return pageLeaves(routesDir).some((page_file) => routeCsrIsFalse(page_file, routesDir));
}

// ─────────────────────────────────────────────────────────────────────────────
// keep-client-build injection — the standalone-build fs helpers.
//
// All-csr=false apps make Kit skip its ENTIRE client build, so ogygia's runtime is never emitted
// and islands 404 at runtime. Fix: during a build, inject a URL-less keepalive layout — a single
// `csr = true` node with no `+page`, so no servable URL — which flips Kit's `skip_client_build`
// check and lets Kit's OWN client build run (honoring the user's preprocessors, appDir, etc.). It
// is removed at process exit by the adapter (main thread only).
// ─────────────────────────────────────────────────────────────────────────────

/** On-disk path of the injected keepalive route for a given app root. */
export function keep_client_dir(r: string): string {
	return path.join(r, 'src', 'routes', KEEP_CLIENT_DIR);
}

/** Write the URL-less `csr = true` keepalive layout into the app's routes (removed at process exit). */
export function inject_keep_client_route(r: string): void {
	const dir = keep_client_dir(r);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, '+layout.ts'),
		'// Generated by ogygia for the duration of the build, then removed. A layout-only node —\n' +
			'// no +page, so no servable URL — that stops SvelteKit skipping its client build when every\n' +
			'// real route is csr = false. Safe to delete (gitignored; ogygia self-heals it).\n' +
			'export const csr = true;\n'
	);
}

/** Remove leftover on-disk `.ogygia` trees from an earlier materialization approach. */
export function clean_stale_ogygia_dirs(dir: string): void {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = path.join(dir, entry.name);
		if (entry.name === 'node_modules') continue;
		if (entry.name === ISLAND_DIR) {
			fs.rmSync(full, { recursive: true, force: true });
			continue;
		}
		clean_stale_ogygia_dirs(full);
	}
}
