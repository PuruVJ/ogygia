import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/index.js', import.meta.url));

// Client shims for Kit `$app/*` used when we build islands WITHOUT sveltekit().
// NOTE: `$app/paths/internal/client` (imported by Kit's reused remote client) MUST come before the
// `$app/paths` entry — a vite string alias also matches the `$app/paths/…` prefix, so without the
// more-specific entry first, `$app/paths/internal/client` would rewrite to `app-paths.js/internal/
// client` and fail to load (only bites a standalone build that includes a remote island).
const APP_ALIASES = {
	'$app/paths/internal/client': fileURLToPath(new URL('../shims/kit-remote/paths-internal-stub.js', import.meta.url)),
	'$app/paths': fileURLToPath(new URL('../shims/app-paths.js', import.meta.url)),
	// Kit's reused client `prerender.svelte.js` imports `version` from the internal `$app/env` module
	// (a Kit virtual absent in a standalone build) — point it at our environment shim.
	'$app/env': fileURLToPath(new URL('../shims/app-environment.js', import.meta.url)),
	'$app/environment': fileURLToPath(new URL('../shims/app-environment.js', import.meta.url)),
	'$app/state': fileURLToPath(new URL('../shims/app-state.svelte.js', import.meta.url)),
	'$app/stores': fileURLToPath(new URL('../shims/app-stores.js', import.meta.url)),
	'$app/navigation': fileURLToPath(new URL('../shims/app-navigation.js', import.meta.url))
};

/** Kit's djb2 hash (src/utils/hash.js), used for `.remote` function ids. */
export function kitHash(str) {
	let hash = 5381;
	let i = str.length;
	while (i) hash = (hash * 33) ^ str.charCodeAt(--i);
	return (hash >>> 0).toString(36);
}

const REMOTE_FILE = /\.remote\.(js|ts|mjs)$/;
// Match `query.batch` / `query.live` before bare `query`.
const REMOTE_EXPORT =
	/export\s+const\s+(\w+)\s*=\s*(query\.batch|query\.live|query|command|form|prerender)\s*\(/g;
const CSR_EXPORT = /export\s+const\s+csr\s*=\s*(true|false)/;
const BACKSLASH = /\\/g;

const TYPE_MAP = {
	'query.batch': 'query_batch',
	'query.live': 'query_live',
	query: 'query',
	command: 'command',
	form: 'form',
	prerender: 'prerender'
};

/**
 * Reproduces Kit's CLIENT `.remote` transform: turn a `.remote` module into stubs that
 * call `__sveltekit/remote` (which we alias to our island remote client). Only used in
 * the standalone build, where sveltekit()'s own remote plugin isn't present.
 */
export function remoteStubPlugin(root) {
	return {
		name: 'ogygia-remote-stub',
		enforce: 'pre',
		transform(code, id) {
			const clean = id.split('?')[0];
			if (!REMOTE_FILE.test(clean)) return null;
			const rel = path.relative(root, clean).split(path.sep).join('/');
			const h = kitHash(rel);
			const stubs = [];
			REMOTE_EXPORT.lastIndex = 0;
			let m;
			while ((m = REMOTE_EXPORT.exec(code))) {
				stubs.push(`export const ${m[1]} = __r.${TYPE_MAP[m[2]]}(${JSON.stringify(h + '/' + m[1])});`);
			}
			return { code: `import * as __r from '__sveltekit/remote';\n${stubs.join('\n')}\n`, map: null };
		}
	};
}

/** Read `export const csr = true|false` from a route option file. */
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
 * Replicates Kit's `nodes.every(n => n.page_options?.csr === false)` client-build skip
 * check: true when every page route resolves (through its layout chain) to csr === false.
 */
export function allRoutesCsrFalse(routesDir) {
	if (!fs.existsSync(routesDir)) return false;
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
	if (leaves.length === 0) return false;

	return leaves.every((page_file) => routeCsrIsFalse(page_file, routesDir));
}

/**
 * Run our own client build for islands + runtime when Kit skips its client build.
 * Outputs into Kit's client output dir so adapters/prerender pick it up.
 */
export async function runStandaloneClientBuild({ root, base, clientDir, makePlugin, sourcemap }) {
	const require = createRequire(path.join(root, 'noop.js'));
	const { build } = await import(path_to_file_url(require.resolve('vite', { paths: [root] })));
	const vps = await import(
		path_to_file_url(require.resolve('@sveltejs/vite-plugin-svelte', { paths: [root] }))
	);

	const result = await build({
		root,
		base: base || '/',
		configFile: false,
		logLevel: 'warn',
		resolve: {
			alias: {
				$lib: path.join(root, 'src', 'lib'),
				...APP_ALIASES
			}
		},
		plugins: [
			remoteStubPlugin(root),
			makePlugin({ standalone: true }),
			vps.svelte({ preprocess: vps.vitePreprocess() })
		],
		build: {
			ssr: false,
			outDir: clientDir,
			emptyOutDir: false,
			assetsDir: '_app/immutable',
			sourcemap: sourcemap ?? false,
			minify: true,
			rolldownOptions: {
				input: RUNTIME_ENTRY,
				// Island emitFile entries often re-export a shared component (two strategies →
				// one Comp). Keep entry `export default` on the facade (Vite 8 / Rolldown).
				preserveEntrySignatures: 'exports-only' as const,
				output: {
					// content-hashed like every other immutable chunk
					entryFileNames: '_app/immutable/ogygia-runtime.[hash].js',
					chunkFileNames: '_app/immutable/[name]-[hash].js',
					assetFileNames: '_app/immutable/[name]-[hash][extname]'
				}
			}
		}
	});

	// find the hashed runtime entry filename to hand back to the (still-running) SSR build
	const outputs = Array.isArray(result) ? result : [result];
	for (const out of outputs) {
		for (const chunk of out.output ?? []) {
			if (chunk.type === 'chunk' && chunk.isEntry && chunk.facadeModuleId === RUNTIME_ENTRY) {
				return { runtimeFileName: chunk.fileName };
			}
		}
	}
	return { runtimeFileName: null };
}

function path_to_file_url(p: string) {
	return new URL(`file://${p.replace(BACKSLASH, '/')}`).href;
}
