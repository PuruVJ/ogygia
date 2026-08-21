import path from 'node:path';
import fs from 'node:fs';
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

/** Read `export const csr = true|false` from a route options file; `undefined` if unset/absent. */
export function read_csr(file: string) {
	try {
		let src = fs.readFileSync(file, 'utf-8');
		// Strip comments so a COMMENTED-OUT `export const csr = …` never wins the (first-match) regex —
		// e.g. a stale `// export const csr = true` above a real `export const csr = false` would
		// otherwise read `true` and make ogygia strip islands from a page Kit renders csr=false. Block
		// comments, plus WHOLE-LINE `//` comments only (a partial-line `//` is left so it can't eat a
		// `://` inside a string; a trailing comment can't flip the reading — the real export matches first).
		src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
		const m = CSR_EXPORT.exec(src);
		return m ? m[1] === 'true' : undefined;
	} catch {
		return undefined;
	}
}

const OPTION_FILES_PAGE = ['+page.js', '+page.ts', '+page.server.js', '+page.server.ts'];
const OPTION_FILES_LAYOUT = ['+layout.js', '+layout.ts', '+layout.server.js', '+layout.server.ts'];

/**
 * Kit-effective `csr === false` for a `+page.svelte` / `+layout.svelte` host (layout chain +
 * page options). `undefined` in sources means Kit's default (`true`).
 * @param hostFile abs path to a route `.svelte`
 * @param routesDir abs `src/routes`
 */
export function routeCsrIsFalse(hostFile: string, routesDir: string) {
	if (!hostFile.startsWith(routesDir)) return false;
	const base = path.basename(hostFile);
	if (base !== '+page.svelte' && base !== '+layout.svelte') return false;

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
	if (base === '+page.svelte') {
		for (const f of OPTION_FILES_PAGE) {
			const v = read_csr(path.join(dir, f));
			if (v !== undefined) csr = v;
		}
	}
	return csr === false;
}

/**
 * True when `hostFile` is a route host (`+page.svelte` / `+layout.svelte`) whose effective csr is
 * TRUE (Kit's default, or an explicit `csr = true` that beats a `false` up the chain). On such a host
 * ogygia steps aside — Kit hydrates the page itself. `false` for non-route files (shared components):
 * their csr depends on which page renders them, so they keep their islands.
 */
export function routeCsrIsTrue(hostFile: string, routesDir: string) {
	const base = path.basename(hostFile);
	if (base !== '+page.svelte' && base !== '+layout.svelte') return false;
	if (!hostFile.startsWith(routesDir)) return false;
	return !routeCsrIsFalse(hostFile, routesDir);
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
