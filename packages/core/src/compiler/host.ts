/**
 * The compiler's HOST environment — the filesystem, path, and hash primitives it reaches for. Node is
 * the default (the shipped Vite plugin uses real `node:fs` / `node:path` / `node:crypto`, unchanged and
 * at full speed); a BROWSER build (the Observatory REPL / `compiler/browser`) installs a virtual host via
 * {@link set_host} — an in-memory filesystem over the workspace file-map, `path`-browserify, and a small
 * md5/sha implementation — so the SAME compiler runs in-browser with no bundler shims.
 *
 * This is the same seam as {@link ./parse/oxc.ts set_parser}: a settable singleton, defaulting to Node,
 * that keeps the driver bundler- and platform-agnostic. `fs` and `path` are exposed as thin proxies over
 * the current host so call-sites read exactly as before (`fs.readFileSync(…)`, `path.join(…)`) — the get
 * indirection is off the token-hot path (the transform's own reads go through the injected `HostCtx`, not
 * this), so it costs the Node build nothing measurable.
 */
import { createRequire } from 'node:module';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Directory entry (a `readdirSync(dir, { withFileTypes: true })` element). */
export interface HostDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}
/** File stats (`statSync`) — only the members the compiler reads. */
export interface HostStats {
	isDirectory(): boolean;
	isFile(): boolean;
	mtimeMs?: number;
	size?: number;
}
/** The filesystem surface the compiler uses. Reads must be real (the driver resolves the module graph
 *  through them); writes are the build's on-disk emits — a browser host keeps them in memory or no-ops. */
export interface HostFs {
	readFileSync(p: string, enc?: any): string;
	existsSync(p: string): boolean;
	/** `string[]` normally, `HostDirent[]` with `{ withFileTypes: true }` — hence `any[]`. */
	readdirSync(p: string, opts?: any): any[];
	statSync(p: string): HostStats;
	globSync(pattern: string | string[], opts?: any): string[];
	writeFileSync(p: string, data: string): void;
	mkdirSync(p: string, opts?: any): void;
	rmSync(p: string, opts?: any): void;
	renameSync(from: string, to: string): void;
}
/** The `path` surface (node's `path` and `path`-browserify both satisfy this). */
export type HostPath = typeof import('node:path');
/** The one hash the compiler needs — `createHash(algo).update(s).digest('hex')` (md5 ids, sha256 hashes). */
export interface HostHasher {
	update(data: string): HostHasher;
	digest(enc: 'hex'): string;
}
export interface HostCrypto {
	createHash(algo: string): HostHasher;
}

/** A complete host environment. Install one in a non-Node realm via {@link set_host}. */
export interface CompilerHost {
	fs: HostFs;
	path: HostPath;
	crypto: HostCrypto;
}

// Node's default host is loaded LAZILY (first access), NOT statically imported, so a BROWSER build never
// eagerly pulls `node:fs` etc.: the browser installs a virtual host via set_host() before the first
// compile, so this default is never reached there. (Same reasoning as the oxc parser seam.)
let node_host: CompilerHost | undefined;
function node_default(): CompilerHost {
	if (!node_host) {
		const require = createRequire(import.meta.url);
		node_host = {
			fs: require('node:fs') as HostFs,
			path: require('node:path') as HostPath,
			crypto: require('node:crypto') as HostCrypto
		};
	}
	return node_host;
}

let current: CompilerHost | null = null;
function host(): CompilerHost {
	return current ?? node_default();
}

/**
 * Install a browser (or test) host. No-arg resets to the Node default. Call once, before the first
 * compile: the browser worker builds a virtual host over its workspace file-map and installs it here.
 */
export function set_host(h?: CompilerHost): void {
	current = h ?? null;
}

/** The current host's `fs` — read `fs.readFileSync(…)` exactly as with `node:fs`. */
export const fs: HostFs = new Proxy({} as HostFs, {
	get: (_t, key) => (host().fs as any)[key]
});
/** The current host's `path` — `path.join(…)` / `path.sep` exactly as with `node:path`. */
export const path: HostPath = new Proxy({} as HostPath, {
	get: (_t, key) => (host().path as any)[key]
});
/** The current host's `createHash` — `createHash('md5').update(s).digest('hex')`. */
export function createHash(algo: string): HostHasher {
	return host().crypto.createHash(algo);
}
