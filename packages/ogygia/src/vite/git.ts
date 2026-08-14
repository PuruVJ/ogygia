/**
 * `import.meta.ogygia.loader.git()` — the compiler-materialized git loader. A build-time construct
 * (like `import.meta.glob`): the ogygia Vite plugin sees the call with a LITERAL spec, materializes a
 * shallow checkout of the repo into a glob-able cache, and rewrites the call to
 * `folder(import.meta.glob('<cache>/…', { eager: true }), <opts>)`. So docs whose bodies COMPILE
 * (markdown/islands) can be sourced straight from another repo — no committed copy, no sync script.
 *
 * The spec is ONE literal string, `owner/repo[@ref][:path]`, so the plugin parses it without touching
 * the (verbatim, forwarded) folder-options object — which may hold regex literals. Node-only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BuildCache, configure_build_cache } from '../build-cache.js';

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
	if (!m) throw new Error(`[ogygia] import.meta.ogygia.loader.git(): bad spec '${spec}' — expected 'owner/repo[@ref][:path]'`);
	return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? 'HEAD', sub: (m[4] ?? '').replace(/^\/+|\/+$/g, '') };
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

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

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
		throw new Error(`[ogygia] git(${spec.owner}/${spec.repo}): frozen build, but no materialized checkout. Restore the node_modules/.ogygia cache, run a non-frozen build first, or pin a sha in the spec.`);
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

// ── source rewrite: import.meta.ogygia.loader.git(spec, opts) → folder(import.meta.glob(…), opts) ──

const CALL = 'import.meta.ogygia.loader.git';
/** Unique alias so injecting the folder import can't collide with a user's own `folder` import. */
const FOLDER_ALIAS = '__ogygia_git_folder';

export type GitCall = { start: number; end: number; spec: GitSpec; opts: string };

/** A `/` begins a regex (not division) when the previous significant char is an operator/opener —
 *  which is always the case for a regex option value (`{ page: /…/ }`, `[/…/, /…/]`). */
function regex_context(prev: string): boolean {
	return prev === '' || '([{,;:=!&|?+-~^<>*%'.includes(prev);
}

/** Index of the `)` matching the `(` at `open`, skipping strings, comments, and regex literals
 *  (incl. `[…]` char classes, which may hold an unescaped `/`). -1 if unbalanced. */
function match_close(src: string, open: number): number {
	let depth = 0;
	let prev = '';
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		const c2 = src[i + 1];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			for (i++; i < src.length; i++) {
				if (src[i] === '\\') i++;
				else if (src[i] === q) break;
			}
			prev = c;
			continue;
		}
		if (c === '/' && c2 === '/') {
			for (i += 2; i < src.length && src[i] !== '\n'; i++) {}
			continue;
		}
		if (c === '/' && c2 === '*') {
			for (i += 2; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) {}
			i++;
			continue;
		}
		if (c === '/' && regex_context(prev)) {
			let in_class = false;
			for (i++; i < src.length; i++) {
				const r = src[i]!;
				if (r === '\\') i++;
				else if (r === '[') in_class = true;
				else if (r === ']') in_class = false;
				else if (r === '/' && !in_class) break;
			}
			while (i + 1 < src.length && /[a-z]/i.test(src[i + 1]!)) i++; // regex flags
			prev = '/';
			continue;
		}
		if (c === '(' || c === '{' || c === '[') {
			depth++;
			prev = c;
			continue;
		}
		if (c === ')' || c === '}' || c === ']') {
			if (--depth === 0) return i;
			prev = c;
			continue;
		}
		if (!/\s/.test(c)) prev = c;
	}
	return -1;
}

/** Split a call's argument text into the first-arg spec string (unquoted) and the verbatim rest. */
function split_first_arg(args: string): { spec: string; rest: string } {
	let i = 0;
	while (i < args.length && /\s/.test(args[i]!)) i++;
	const q = args[i];
	if (q !== "'" && q !== '"' && q !== '`') {
		throw new Error(`[ogygia] import.meta.ogygia.loader.git(): the first argument must be a string-literal spec, got '${args.slice(0, 24)}…'`);
	}
	let j = i + 1;
	for (; j < args.length; j++) {
		if (args[j] === '\\') j++;
		else if (args[j] === q) break;
	}
	const spec = args.slice(i + 1, j);
	let k = j + 1;
	while (k < args.length && /\s/.test(args[k]!)) k++;
	if (args[k] === ',') k++;
	return { spec, rest: args.slice(k).trim() };
}

/**
 * Locate every `import.meta.ogygia.loader.git(spec[, opts])` CALL in a module's source. Pure. A
 * single pass that skips strings, comments, and regex literals, so the marker inside a doc comment
 * (`import.meta.ogygia.loader.git()` in this very docstring) or a string is NOT mistaken for a call.
 */
export function find_git_calls(src: string): GitCall[] {
	const calls: GitCall[] = [];
	let prev = '';
	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;
		const c2 = src[i + 1];
		if (c === "'" || c === '"' || c === '`') {
			const q = c;
			for (i++; i < src.length; i++) {
				if (src[i] === '\\') i++;
				else if (src[i] === q) break;
			}
			prev = c;
			continue;
		}
		if (c === '/' && c2 === '/') {
			for (i += 2; i < src.length && src[i] !== '\n'; i++) {}
			continue;
		}
		if (c === '/' && c2 === '*') {
			for (i += 2; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) {}
			i++;
			continue;
		}
		if (c === '/' && regex_context(prev)) {
			let in_class = false;
			for (i++; i < src.length; i++) {
				const r = src[i]!;
				if (r === '\\') i++;
				else if (r === '[') in_class = true;
				else if (r === ']') in_class = false;
				else if (r === '/' && !in_class) break;
			}
			while (i + 1 < src.length && /[a-z]/i.test(src[i + 1]!)) i++;
			prev = '/';
			continue;
		}
		// A marker in CODE context (not a string/comment/regex — those `continue`d above).
		if (c === 'i' && src.startsWith(CALL, i)) {
			let p = i + CALL.length;
			while (p < src.length && /\s/.test(src[p]!)) p++;
			if (src[p] === '(') {
				const close = match_close(src, p);
				if (close >= 0) {
					const { spec, rest } = split_first_arg(src.slice(p + 1, close));
					calls.push({ start: i, end: close + 1, spec: parse_git_spec(spec), opts: rest });
					i = close;
					prev = ')';
					continue;
				}
			}
			i += CALL.length - 1;
			prev = 't';
			continue;
		}
		if (!/\s/.test(c)) prev = c;
	}
	return calls;
}

/**
 * Rewrite every git-loader call in `src` to a `folder(import.meta.glob(…), opts)` expression and
 * inject the (aliased) folder import. Returns the new code plus the specs to materialize. Pure — the
 * rewritten CODE never depends on the checkout, so the plugin materializes the specs separately
 * (before Vite's glob plugin scans the emitted pattern). Keeping the corpus out of client bundles is
 * the `.server.ts` placement rule's job (see the plugin's content-placement warning), not a rewrite
 * concern — Kit's server-module guard enforces it mechanically.
 */
export function rewrite_git_loaders(src: string): { code: string; specs: GitSpec[] } {
	const calls = find_git_calls(src);
	if (!calls.length) return { code: src, specs: [] };
	let out = '';
	let last = 0;
	for (const c of calls) {
		const pattern = git_glob_pattern(c.spec);
		const opts = c.opts ? `, ${c.opts}` : '';
		out += src.slice(last, c.start);
		out += `${FOLDER_ALIAS}(import.meta.glob(${JSON.stringify(pattern)}, { eager: true })${opts})`;
		last = c.end;
	}
	out += src.slice(last);
	return { code: `import { folder as ${FOLDER_ALIAS} } from 'ogygia/content';\n` + out, specs: calls.map((c) => c.spec) };
}
