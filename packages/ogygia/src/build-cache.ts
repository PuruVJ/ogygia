/**
 * ogygia's BUILD CACHE — one shared, namespaced store for everything derived at build time. Node-only.
 *
 * Each consumer initialises its own corner: `new BuildCache<T>('fences')` — its namespace is its
 * directory inside the shared root, and it speaks `get`/`set` (JSON values) or `dir()` (an artifact
 * tree it manages itself, like git checkouts) — never filesystem paths. Where things persist is this
 * MODULE's concern: `node_modules/.ogygia/<namespace>/…` — inside `node_modules` deliberately,
 * because build platforms cache that whole tree, so a warm CI build re-derives nothing (no clone,
 * no shiki, no twoslash).
 *
 * Everything is best-effort: any FS error disables the cache for the session rather than failing a
 * build — a cache must never be the reason a build breaks.
 */
// fs/path come through the compiler HOST SEAM (not `node:*` directly) so this module — and the whole
// content/markdown pipeline that rides it — loads in a BROWSER realm (the Observatory REPL) with no
// node shims. The host defaults to Node, so the shipped Vite plugin is byte-identical + full-speed; a
// browser installs a virtual host + calls `__set_build_cache_root(null)` to disable the on-disk cache.
import { fs, path } from './compiler/host.js';

// The shared root — module state, not part of any store's surface. Resolved lazily; before any
// configure it falls back to `process.cwd()`.
let root: string | null | undefined;
let configured: string | undefined;

/** Point the cache at a project (the Vite plugin calls this with the app root at config time). */
export function configure_build_cache(project_root: string): void {
	if (configured === project_root) return;
	configured = project_root;
	root = undefined; // re-probe under the new project
}

/** Test hook: force the cache root (or `null` to disable, `undefined` to re-probe). */
export function __set_build_cache_root(dir: string | null | undefined): void {
	root = dir;
	if (dir === undefined) configured = undefined;
}

function cache_root(): string | null {
	if (root !== undefined) return root;
	try {
		const d = path.join(configured ?? process.cwd(), 'node_modules', '.ogygia');
		fs.mkdirSync(d, { recursive: true });
		root = d;
	} catch {
		root = null;
	}
	return root;
}

export class BuildCache<T> {
	constructor(readonly namespace: string) {}

	/** This namespace's DIRECTORY, for artifact trees the consumer manages itself (git checkouts).
	 *  Returns the ensured absolute path, or `null` when the cache is unavailable. */
	dir(): string | null {
		const r = cache_root();
		if (!r) return null;
		try {
			const d = path.join(r, this.namespace);
			fs.mkdirSync(d, { recursive: true });
			return d;
		} catch {
			return null;
		}
	}

	get(key: string): T | null {
		const d = this.dir();
		if (!d) return null;
		try {
			return JSON.parse(fs.readFileSync(path.join(d, key + '.json'), 'utf8')) as T;
		} catch {
			return null;
		}
	}

	set(key: string, value: T): void {
		const d = this.dir();
		if (!d) return;
		try {
			// Write-then-rename so a crashed write can't leave a torn entry at the final address.
			const tmp = path.join(d, key + '.' + process.pid + '.tmp');
			fs.writeFileSync(tmp, JSON.stringify(value));
			fs.renameSync(tmp, path.join(d, key + '.json'));
		} catch {
			/* best-effort — a failed write just means a recompute next time */
		}
	}
}
