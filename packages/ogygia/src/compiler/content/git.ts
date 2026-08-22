/**
 * `import.meta.og.loader.git()` materialization — the Node side of the compiler git loader. A
 * build-time construct (like `import.meta.glob`): the plugin sees the call with a LITERAL spec,
 * materializes a shallow checkout of the repo into a glob-able cache, and (in `./loaders.ts`)
 * rewrites the call to `folder(import.meta.glob('<cache>/…', { eager: true }), <opts>)`. So docs
 * whose bodies COMPILE (markdown/islands) can be sourced straight from another repo — no committed
 * copy, no sync script.
 *
 * The spec is ONE literal string, `owner/repo[@ref][:path]`, so the plugin parses it without touching
 * the (verbatim, forwarded) folder-options object — which may hold regex literals. Node-only.
 */
import { execFileSync } from 'node:child_process';
import { fs, path } from '../host.js';
import { BuildCache, configure_build_cache } from '../../build-cache.js';

// git's own corners of the shared build cache: resolved shas (kv) + the checkout trees (a dir).
// Persistence location is the cache's concern — git thinks in get/set and a directory, never paths.
const sha_cache = new BuildCache<string>('git');
const content_cache = new BuildCache<never>('content');

/** A parsed git source spec. */
export type GitSpec = { owner: string; repo: string; ref: string; sub: string };

const SPEC_RE = /^([^/\s]+)\/([^@:\s]+)(?:@([^:\s]+))?(?::(.+))?$/;

/** Parse `owner/repo[@ref][:path]` → its parts. Default ref `HEAD`, default sub `''`. Throws on garbage. */
export function parse_git_spec(spec: string): GitSpec {
	const m = SPEC_RE.exec(spec.trim());
	if (!m)
		throw new Error(
			`[ogygia] import.meta.og.loader.git(): bad spec '${spec}' — expected 'owner/repo[@ref][:path]'`
		);
	return {
		owner: m[1]!,
		repo: m[2]!,
		ref: m[3] ?? 'HEAD',
		sub: (m[4] ?? '').replace(/^\/+|\/+$/g, '')
	};
}

/** Stable cache slug for a spec (ref-agnostic — the checkout is updated in place, lock pins the sha). */
export function git_slug(s: GitSpec): string {
	return `${s.owner}-${s.repo}`.replace(/[^\w.-]/g, '_');
}

/** Absolute checkout dir for a spec — the `content` cache namespace + slug. Throws when the build
 *  cache is unavailable: unlike every derived cache, the checkout IS the corpus — there is nothing
 *  to recompute without it. */
export function git_checkout_dir(s: GitSpec): string {
	const base = content_cache.dir();
	if (!base) {
		throw new Error(
			`[ogygia] git(${s.owner}/${s.repo}): the build cache (node_modules/.ogygia) is unavailable — cannot materialize a checkout.`
		);
	}
	return path.join(base, git_slug(s));
}

/**
 * The `import.meta.glob` pattern the call rewrites to — ROOT-absolute (`/…`, relative to the Vite
 * project root) so it works regardless of which file holds the call. `ext` narrows the glob (default
 * `md`), NOT `**\/*` (that would drag colocated assets in).
 */
export function git_glob_pattern(s: GitSpec, ext = 'md'): string {
	const base = ['/node_modules/.ogygia/content', git_slug(s), s.sub].filter(Boolean).join('/');
	return `${base}/**/*.${ext}`;
}

// ── resolved shas: one `git` cache entry per repo slug. Lives WITH the checkouts in the shared
// build cache, so build platforms that cache node_modules keep the pin AND the corpus together — a
// warm CI build fetches nothing. It's cache, not committed intent: absent entry → re-resolve the
// ref. To PIN a build hermetically, put the sha in the spec (`owner/repo@<sha>:path`). ──

export function read_sha(slug: string): string | null {
	return sha_cache.get(slug);
}
export function write_sha(slug: string, sha: string): void {
	sha_cache.set(slug, sha);
}

// ── materialization (git ops) ──

const git = (args: string[], cwd?: string) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim();

/**
 * Ensure a shallow, sparse checkout of `spec` exists in the cache, and return its dir + resolved sha.
 * Idempotent: an existing checkout at the locked sha is left alone. `frozen` (CI) refuses to fetch —
 * it errors if the lock's sha isn't already materialized. `base_url` overrides the GitHub origin (a
 * local mirror for tests/offline).
 */
export function materialize(
	spec: GitSpec,
	opts: { root: string; frozen?: boolean; base_url?: string } = { root: process.cwd() }
): { dir: string; sha: string } {
	configure_build_cache(opts.root);
	const dir = git_checkout_dir(spec);
	const slug = git_slug(spec);
	const locked = read_sha(slug);

	const have = fs.existsSync(path.join(dir, '.git'));
	const current = have ? safe(() => git(['rev-parse', 'HEAD'], dir)) : null;

	// Already at the locked sha (or frozen with a good checkout) → done, no network.
	if (locked && current === locked) return { dir, sha: locked };
	if (opts.frozen) {
		if (current) return { dir, sha: current };
		throw new Error(
			`[ogygia] git(${spec.owner}/${spec.repo}): frozen build, but no materialized checkout. Restore the node_modules/.ogygia cache, run a non-frozen build first, or pin a sha in the spec.`
		);
	}

	const url = `${opts.base_url ?? 'https://github.com'}/${spec.owner}/${spec.repo}.git`;
	if (!have) {
		fs.rmSync(dir, { recursive: true, force: true });
		const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout'];
		if (spec.ref !== 'HEAD') args.push('--branch', spec.ref);
		git([...args, url, dir]);
		git(['sparse-checkout', 'init', '--cone'], dir);
		git(['sparse-checkout', 'set', spec.sub || '/'], dir);
		git(['checkout'], dir);
	} else {
		git(['fetch', '--depth', '1', 'origin', spec.ref], dir);
		git(['sparse-checkout', 'set', spec.sub || '/'], dir);
		git(['checkout', 'FETCH_HEAD'], dir);
	}
	const sha = git(['rev-parse', 'HEAD'], dir);
	write_sha(slug, sha);
	return { dir, sha };
}

function safe<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}

// The source rewrite (`import.meta.og.loader.git(spec, opts)` → `folder(import.meta.glob(…), opts)`)
// lives in `./loaders.ts`, alongside the other `import.meta.og.loader.*` constructs — it shares the
// one `import.meta.og.*` scanner in `./og-lexer.ts`. This module is now purely: parse a spec,
// name its cache slot, and materialize the checkout.
