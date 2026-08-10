import path from 'node:path';
import fs from 'node:fs';

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

const CSR_EXPORT = /export\s+const\s+csr\s*=\s*(true|false)/;

/** Read `export const csr = true|false` from a route options file; `undefined` if unset/absent. */
export function read_csr(file) {
	try {
		const src = fs.readFileSync(file, 'utf-8');
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
 * @param {string} hostFile abs path to a route `.svelte`
 * @param {string} routesDir abs `src/routes`
 */
export function routeCsrIsFalse(hostFile, routesDir) {
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
export function routeCsrIsTrue(hostFile, routesDir) {
	const base = path.basename(hostFile);
	if (base !== '+page.svelte' && base !== '+layout.svelte') return false;
	if (!hostFile.startsWith(routesDir)) return false;
	return !routeCsrIsFalse(hostFile, routesDir);
}

function pageLeaves(routesDir) {
	/** @type {string[]} */
	const leaves = [];
	const walk = (dir) => {
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
function own_csr(dir, universal, server) {
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
 * Collects every route node's OWN csr the way Kit does — a node exists per `+page` and per
 * `+layout` (component OR standalone module). Layout groups like `(ogygia)/+layout.ts` count too.
 * @returns {Array<boolean | undefined>} one entry per node (undefined = csr unset on that node)
 */
function collectNodeOwnCsr(routesDir) {
	/** @type {Array<boolean | undefined>} */
	const nodes = [];
	let saw_root_layout = false;
	const walk = (dir, is_root) => {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));

		const has = (list) => list.some((f) => names.has(f));
		// layout node: +layout.svelte, +layout.js/ts, or +layout.server.js/ts
		if (names.has('+layout.svelte') || has(LAYOUT_UNIVERSAL) || has(LAYOUT_SERVER)) {
			if (is_root) saw_root_layout = true;
			nodes.push(own_csr(dir, LAYOUT_UNIVERSAL, LAYOUT_SERVER));
		}
		// page node: +page.svelte, +page.js/ts, or +page.server.js/ts
		if (names.has('+page.svelte') || has(PAGE_UNIVERSAL) || has(PAGE_SERVER)) {
			nodes.push(own_csr(dir, PAGE_UNIVERSAL, PAGE_SERVER));
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name === KEEP_CLIENT_DIR) continue; // ignore our own injected keepalive
			walk(path.join(dir, e.name), false);
		}
	};
	walk(routesDir, true);
	// Kit always synthesizes a root layout node; if the app has none, it carries null options
	// (csr unset) — which alone is enough to keep the client build alive.
	if (!saw_root_layout) nodes.push(undefined);
	return nodes;
}

/**
 * Replicates Kit's `manifest_data.nodes.every(n => n.page_options?.csr === false)` — the exact
 * condition under which Kit skips the client build. Reads each node's OWN csr (NOT the resolved
 * layout chain), so a single node whose csr is `true` (e.g. an `(ogygia)/+layout.ts` keepalive)
 * or simply unset keeps the build alive. When this is true, ogygia's runtime is never emitted.
 */
export function clientBuildWillSkip(routesDir) {
	if (!fs.existsSync(routesDir)) return false;
	const nodes = collectNodeOwnCsr(routesDir);
	if (nodes.length === 0) return false;
	return nodes.every((csr) => csr === false);
}

/**
 * True when AT LEAST ONE page route is csr=false. A pure csr=true app (this returns false) needs no
 * ogygia runtime at all — Kit hydrates everything itself — so the runtime chunk is skipped entirely.
 */
export function hasAnyCsrFalseRoute(routesDir) {
	if (!fs.existsSync(routesDir)) return false;
	return pageLeaves(routesDir).some((page_file) => routeCsrIsFalse(page_file, routesDir));
}
