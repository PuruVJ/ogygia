import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/index.js', import.meta.url));

// Client shims for Kit `$app/*` used when we build islands WITHOUT sveltekit().
const APP_ALIASES = {
	'$app/paths': fileURLToPath(new URL('../shims/app-paths.js', import.meta.url)),
	'$app/environment': fileURLToPath(new URL('../shims/app-environment.js', import.meta.url)),
	'$app/state': fileURLToPath(new URL('../shims/app-state.js', import.meta.url)),
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

const TYPE_MAP = {
	query: 'query',
	'query.live': 'query_live',
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
			if (!/\.remote\.(js|ts|mjs)$/.test(clean)) return null;
			const rel = path.relative(root, clean).split(path.sep).join('/');
			const h = kitHash(rel);
			const stubs = [];
			const re = /export\s+const\s+(\w+)\s*=\s*(query\.live|query|command|form|prerender)\s*\(/g;
			let m;
			while ((m = re.exec(code))) {
				stubs.push(`export const ${m[1]} = __r.${TYPE_MAP[m[2]]}(${JSON.stringify(h + '/' + m[1])});`);
			}
			return { code: `import * as __r from '__sveltekit/remote';\n${stubs.join('\n')}\n`, map: null };
		}
	};
}

/** Read `export const csr = true|false` from a route option file. */
function read_csr(file) {
	try {
		const src = fs.readFileSync(file, 'utf-8');
		const m = /export\s+const\s+csr\s*=\s*(true|false)/.exec(src);
		return m ? m[1] === 'true' : undefined;
	} catch {
		return undefined;
	}
}

const OPTION_FILES_PAGE = ['+page.js', '+page.ts', '+page.server.js', '+page.server.ts'];
const OPTION_FILES_LAYOUT = ['+layout.js', '+layout.ts', '+layout.server.js', '+layout.server.ts'];

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

	const effective_csr = (page_file) => {
		let csr; // undefined => Kit default (true)
		const dir = path.dirname(page_file);
		// layout chain from routes root down to this dir
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
		for (const f of OPTION_FILES_PAGE) {
			const v = read_csr(path.join(dir, f));
			if (v !== undefined) csr = v;
		}
		return csr === false;
	};

	return leaves.every(effective_csr);
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
			rollupOptions: {
				input: RUNTIME_ENTRY,
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
	return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}
