import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	parse_git_spec,
	git_slug,
	git_glob_pattern,
	git_checkout_dir,
	read_sha,
	write_sha
} from '../src/compiler/content/git.js';
import {
	find_loader_calls,
	rewrite_loaders,
	expand_braces,
	loader_patterns
} from '../src/compiler/content/loaders.js';
import { __set_build_cache_root } from '../src/build-cache.js';

describe('parse_git_spec', () => {
	it('owner/repo → default ref HEAD, empty sub', () => {
		expect(parse_git_spec('sveltejs/svelte')).toEqual({
			owner: 'sveltejs',
			repo: 'svelte',
			ref: 'HEAD',
			sub: ''
		});
	});
	it('owner/repo:path → sub, default ref', () => {
		expect(parse_git_spec('sveltejs/svelte:documentation/docs')).toEqual({
			owner: 'sveltejs',
			repo: 'svelte',
			ref: 'HEAD',
			sub: 'documentation/docs'
		});
	});
	it('owner/repo@ref:path → all three', () => {
		expect(parse_git_spec('sveltejs/kit@main:documentation/docs')).toEqual({
			owner: 'sveltejs',
			repo: 'kit',
			ref: 'main',
			sub: 'documentation/docs'
		});
	});
	it('strips leading/trailing slashes from the sub path', () => {
		expect(parse_git_spec('a/b:/x/y/').sub).toBe('x/y');
	});
	it('throws on a spec with no owner/repo', () => {
		expect(() => parse_git_spec('not-a-repo')).toThrow(/bad spec/);
	});
});

describe('git_slug', () => {
	it('is owner-repo, filesystem-safe', () => {
		expect(git_slug(parse_git_spec('sveltejs/svelte'))).toBe('sveltejs-svelte');
	});
});

describe('git_glob_pattern', () => {
	it('is a root-absolute glob under node_modules/.ogygia/content/<slug>/<sub>', () => {
		expect(git_glob_pattern(parse_git_spec('sveltejs/svelte:documentation/docs'))).toBe(
			'/node_modules/.ogygia/content/sveltejs-svelte/documentation/docs/**/*.md'
		);
	});
	it('omits the sub segment when there is none', () => {
		expect(git_glob_pattern(parse_git_spec('a/b'))).toBe(
			'/node_modules/.ogygia/content/a-b/**/*.md'
		);
	});
	it('honors a custom extension', () => {
		expect(git_glob_pattern(parse_git_spec('a/b:docs'), 'svx')).toBe(
			'/node_modules/.ogygia/content/a-b/docs/**/*.svx'
		);
	});
});

describe('git_checkout_dir', () => {
	it('joins under the project cache root', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-git-dir-'));
		__set_build_cache_root(tmp);
		expect(git_checkout_dir(parse_git_spec('a/b'))).toBe(path.join(tmp, 'content', 'a-b'));
		__set_build_cache_root(undefined);
	});
});

describe('find_loader_calls', () => {
	it('finds a bare git call with no options', () => {
		const calls = find_loader_calls(`const s = import.meta.og.loader.git('sveltejs/svelte');`);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('git');
		expect(calls[0]!.args).toBe(`'sveltejs/svelte'`);
	});
	it('finds all four loader kinds', () => {
		const src = [
			`a(import.meta.og.loader.markdown('./docs/**/*.svx'))`,
			`b(import.meta.og.loader.folder('../content/**'))`,
			`c(import.meta.og.loader.json('./authors/*.json'))`,
			`d(import.meta.og.loader.git('a/b'))`
		].join('\n');
		expect(find_loader_calls(src).map((c) => c.method)).toEqual([
			'markdown',
			'folder',
			'json',
			'git'
		]);
	});
	it('captures verbatim options that contain regex literals with slashes in char classes', () => {
		const src = `loader: import.meta.og.loader.git('sveltejs/svelte:documentation/docs', { page: /\\d+-[^/]*\\.md$/, meta: /index\\.md$/ })`;
		const calls = find_loader_calls(src);
		expect(calls).toHaveLength(1);
		// the `)` inside the regex char class `[^/]` must NOT close the call early
		expect(calls[0]!.args).toBe(
			`'sveltejs/svelte:documentation/docs', { page: /\\d+-[^/]*\\.md$/, meta: /index\\.md$/ }`
		);
	});
	it('is not fooled by a close-paren inside a string option', () => {
		const calls = find_loader_calls(
			`x = import.meta.og.loader.git('a/b', { note: 'has ) paren' })`
		);
		expect(calls[0]!.args).toBe(`'a/b', { note: 'has ) paren' }`);
	});
	it('AST path: ignores the marker inside a comment or string (only real call nodes count)', () => {
		const src = [
			`// see import.meta.og.loader.git() for details`,
			`/** import.meta.og.loader.markdown() is a build construct */`,
			`const doc = "call import.meta.og.loader.json() like this";`,
			`export const real = import.meta.og.loader.git('sveltejs/svelte');`
		].join('\n');
		const calls = find_loader_calls(src);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('git');
	});
	it('scanner fallback: still ignores comments/strings when the source does not parse', () => {
		// A deliberately unparseable tail forces the AST path to bail → scanner fallback.
		const src = [
			`// import.meta.og.loader.git() in a comment`,
			`const real = import.meta.og.loader.git('a/b');`,
			`const broken = (`
		].join('\n');
		const calls = find_loader_calls(src);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('git');
	});
});

describe('rewrite_loaders', () => {
	it('git → folder(import.meta.glob(...)) with a lazy glob + aliased import', () => {
		const { code, specs } = rewrite_loaders(
			`export const src = import.meta.og.loader.git('sveltejs/svelte:documentation/docs', { page: /\\.md$/ });`
		);
		expect(code).toContain("import { folder as __og_folder } from 'ogygia/content';");
		expect(code).toContain(
			'__og_folder(import.meta.glob("/node_modules/.ogygia/content/sveltejs-svelte/documentation/docs/**/*.md", { eager: false }), { page: /\\.md$/ })'
		);
		expect(specs).toHaveLength(1);
		expect(specs[0]!.owner).toBe('sveltejs');
	});
	it('markdown → markdown(import.meta.glob(<literal glob>, { eager: false }))', () => {
		const { code, specs } = rewrite_loaders(
			`export const d = import.meta.og.loader.markdown('./docs/**/*.svx');`
		);
		expect(code).toContain("import { markdown as __og_markdown } from 'ogygia/content';");
		expect(code).toContain(`__og_markdown(import.meta.glob("./docs/**/*.svx", { eager: false }))`);
		expect(specs).toHaveLength(0);
	});
	it('json → json(...) and folder → folder(...), importing only what is used', () => {
		const { code } = rewrite_loaders(
			`const a = import.meta.og.loader.json('./x/*.json'); const b = import.meta.og.loader.folder('../c/**');`
		);
		expect(code).toContain(
			"import { folder as __og_folder, json as __og_json } from 'ogygia/content';"
		);
		expect(code).not.toContain('markdown as __og_markdown');
	});
	it('leaves a source with no loader calls untouched (no injected import)', () => {
		const src = `export const x = 1;`;
		expect(rewrite_loaders(src)).toEqual({ code: src, specs: [] });
	});
	it('brace alternation → Vite array form (dev matcher drops `{+doc,…}` braces, so expand them)', () => {
		const { code } = rewrite_loaders(
			`export const d = import.meta.og.loader.folder('../content/docs/**/{+doc.svx,+meta.json}');`
		);
		// Not the single brace string — the expanded array both dev and build agree on.
		expect(code).toContain(
			`__og_folder(import.meta.glob(["../content/docs/**/+doc.svx","../content/docs/**/+meta.json"], { eager: false }))`
		);
		expect(code).not.toContain('{+doc.svx,+meta.json}');
	});
});

describe('expand_braces', () => {
	it('passes a brace-free pattern straight through', () => {
		expect(expand_braces('./docs/**/*.svx')).toEqual(['./docs/**/*.svx']);
	});
	it('expands a single alternation', () => {
		expect(expand_braces('a/{+doc.svx,+meta.json}')).toEqual(['a/+doc.svx', 'a/+meta.json']);
	});
	it('expands multiple groups as a cartesian product', () => {
		expect(expand_braces('{a,b}/{x,y}')).toEqual(['a/x', 'a/y', 'b/x', 'b/y']);
	});
	it('handles nested braces', () => {
		expect(expand_braces('p/{a,{b,c}}')).toEqual(['p/a', 'p/b', 'p/c']);
	});
	it('leaves an unbalanced brace untouched', () => {
		expect(expand_braces('a/{b,c')).toEqual(['a/{b,c']);
	});
});

describe('lockfile round-trip', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
	it('per-slug sha entries round-trip through the shared build cache', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-git-'));
		dirs.push(root);
		__set_build_cache_root(root);
		expect(read_sha('sveltejs-svelte')).toBeNull(); // absent → null
		write_sha('sveltejs-svelte', 'abc123');
		write_sha('a-b', 'def456');
		expect(read_sha('sveltejs-svelte')).toBe('abc123');
		expect(read_sha('a-b')).toBe('def456');
		expect(fs.existsSync(path.join(root, 'git', 'sveltejs-svelte.json'))).toBe(true);
		__set_build_cache_root(undefined);
	});
});

describe('loader_patterns — the opinionated directory form', () => {
	it('folder(dir) derives the +doc.svx / +meta.json convention set', () => {
		expect(loader_patterns('folder', '../content/docs')).toEqual([
			'../content/docs/**/+doc.svx',
			'../content/docs/**/+meta.json'
		]);
	});

	it('markdown(dir) derives *.svx + *.md; json(dir) derives *.json; trailing slash normalized', () => {
		expect(loader_patterns('markdown', './posts/')).toEqual([
			'./posts/**/*.svx',
			'./posts/**/*.md'
		]);
		expect(loader_patterns('json', './authors')).toEqual(['./authors/**/*.json']);
	});

	it('an explicit glob passes through (brace-expanded, unchanged semantics)', () => {
		expect(loader_patterns('markdown', './docs/**/*.svx')).toEqual(['./docs/**/*.svx']);
		expect(loader_patterns('folder', '../c/**/{+doc.svx,+meta.json}')).toEqual([
			'../c/**/+doc.svx',
			'../c/**/+meta.json'
		]);
	});

	it('a file-looking path (dotted basename) is left alone — never treated as a directory', () => {
		expect(loader_patterns('markdown', './intro.svx')).toEqual(['./intro.svx']);
	});

	it('dot-relative directories still expand (`.`/`..` are not file-looking)', () => {
		expect(loader_patterns('json', '..')).toEqual(['../**/*.json']);
	});

	it('rewrite emits the array-form glob for a directory argument (dev + build agree)', () => {
		const { code } = rewrite_loaders(
			`export const docs = import.meta.og.loader.folder('../content/docs', { convention: numbered() });`
		);
		expect(code).toContain(
			`import.meta.glob(["../content/docs/**/+doc.svx","../content/docs/**/+meta.json"], { eager: false })`
		);
		expect(code).toContain(`{ convention: numbered() }`);
	});
});
