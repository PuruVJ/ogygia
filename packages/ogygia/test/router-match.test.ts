import { describe, it, expect } from 'vitest';
import { compile, compile_all, match_one, match_path } from '../src/router/match.js';

describe('router pattern matching', () => {
	it('matches root, static, and params', () => {
		expect(match_one(compile('/'), '/')).toEqual({ pattern: '/', params: {} });
		expect(match_one(compile('/docs/new'), '/docs/new')).toEqual({ pattern: '/docs/new', params: {} });
		expect(match_one(compile('/docs/new'), '/docs/old')).toBeNull();
		expect(match_one(compile('/docs/[slug]'), '/docs/intro')).toEqual({
			pattern: '/docs/[slug]',
			params: { slug: 'intro' }
		});
	});

	it('is trailing-slash-insensitive and decodes params', () => {
		expect(match_one(compile('/docs/[slug]'), '/docs/intro/')!.params).toEqual({ slug: 'intro' });
		expect(match_one(compile('/u/[name]'), '/u/a%20b')!.params).toEqual({ name: 'a b' });
	});

	it('handles [...rest] (may be empty) and [[optional]]', () => {
		expect(match_one(compile('/files/[...path]'), '/files')!.params).toEqual({ path: '' });
		expect(match_one(compile('/files/[...path]'), '/files/a/b/c')!.params).toEqual({ path: 'a/b/c' });
		expect(match_one(compile('/[[lang]]/docs'), '/docs')!.params).toEqual({ lang: undefined });
		expect(match_one(compile('/[[lang]]/docs'), '/en/docs')!.params).toEqual({ lang: 'en' });
	});

	it('orders overlapping routes static > param > rest', () => {
		const sorted = compile_all(['/docs/[slug]', '/docs/new', '/[...all]']);
		expect(sorted.map((c) => c.pattern)).toEqual(['/docs/new', '/docs/[slug]', '/[...all]']);
		expect(match_path(sorted, '/docs/new')!.pattern).toBe('/docs/new');
		expect(match_path(sorted, '/docs/xyz')!.pattern).toBe('/docs/[slug]');
		expect(match_path(sorted, '/anything/here')!.pattern).toBe('/[...all]');
	});

	it('distinguishes dot-suffixed and nested variants (the profiler /report cases)', () => {
		const s = compile_all(['/report/[id]', '/report/[id].json', '/report/[id]/raw']);
		expect(match_path(s, '/report/abc.json')!.pattern).toBe('/report/[id].json');
		expect(match_path(s, '/report/abc')!.pattern).toBe('/report/[id]');
		expect(match_path(s, '/report/abc/raw')!.pattern).toBe('/report/[id]/raw');
	});

	it('rejects malformed patterns loudly', () => {
		expect(() => compile('docs/[slug]')).toThrow(/must start with/);
		expect(() => compile('/a/[...rest]/b')).toThrow(/must be last/);
	});
});
