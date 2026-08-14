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
	write_sha,
	find_git_calls,
	rewrite_git_loaders
} from '../src/vite/git.js';
import { __set_build_cache_root } from '../src/build-cache.js';

describe('parse_git_spec', () => {
	it('owner/repo → default ref HEAD, empty sub', () => {
		expect(parse_git_spec('sveltejs/svelte')).toEqual({ owner: 'sveltejs', repo: 'svelte', ref: 'HEAD', sub: '' });
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
		expect(git_glob_pattern(parse_git_spec('a/b'))).toBe('/node_modules/.ogygia/content/a-b/**/*.md');
	});
	it('honors a custom extension', () => {
		expect(git_glob_pattern(parse_git_spec('a/b:docs'), 'svx')).toBe('/node_modules/.ogygia/content/a-b/docs/**/*.svx');
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

describe('find_git_calls', () => {
	it('finds a bare call with no options', () => {
		const calls = find_git_calls(`const s = import.meta.ogygia.loader.git('sveltejs/svelte');`);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.spec.repo).toBe('svelte');
		expect(calls[0]!.opts).toBe('');
	});
	it('captures verbatim options that contain regex literals with slashes in char classes', () => {
		const src = `loader: import.meta.ogygia.loader.git('sveltejs/svelte:documentation/docs', { page: /\\d+-[^/]*\\.md$/, meta: /index\\.md$/ })`;
		const calls = find_git_calls(src);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.spec.sub).toBe('documentation/docs');
		// the `)` inside the regex char class `[^/]` must NOT close the call early
		expect(calls[0]!.opts).toBe('{ page: /\\d+-[^/]*\\.md$/, meta: /index\\.md$/ }');
	});
	it('is not fooled by a close-paren inside a string option', () => {
		const calls = find_git_calls(`import.meta.ogygia.loader.git('a/b', { note: 'has ) paren' })`);
		expect(calls[0]!.opts).toBe(`{ note: 'has ) paren' }`);
	});
	it('finds multiple calls', () => {
		const src = `x(import.meta.ogygia.loader.git('a/b')); y(import.meta.ogygia.loader.git('c/d:docs'))`;
		expect(find_git_calls(src)).toHaveLength(2);
	});
	it('ignores the marker inside a comment or string (only real code-context calls count)', () => {
		const src = [
			`// see import.meta.ogygia.loader.git() for details`,
			`/** import.meta.ogygia.loader.git() is a build construct */`,
			`const doc = "call import.meta.ogygia.loader.git() like this";`,
			`export const real = import.meta.ogygia.loader.git('sveltejs/svelte');`
		].join('\n');
		const calls = find_git_calls(src);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.spec.repo).toBe('svelte');
	});
});

describe('rewrite_git_loaders', () => {
	it('rewrites to folder(import.meta.glob(...)) + injects the aliased import', () => {
		const { code, specs } = rewrite_git_loaders(
			`export const src = import.meta.ogygia.loader.git('sveltejs/svelte:documentation/docs', { page: /\\.md$/ });`
		);
		expect(code).toContain("import { folder as __ogygia_git_folder } from 'ogygia/content';");
		expect(code).toContain('__ogygia_git_folder(import.meta.glob("/node_modules/.ogygia/content/sveltejs-svelte/documentation/docs/**/*.md", { eager: true }), { page: /\\.md$/ })');
		expect(specs).toHaveLength(1);
		expect(specs[0]!.owner).toBe('sveltejs');
	});
	it('leaves a source with no git calls untouched (no injected import)', () => {
		const src = `export const x = 1;`;
		expect(rewrite_git_loaders(src)).toEqual({ code: src, specs: [] });
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
