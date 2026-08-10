import { describe, expect, it } from 'vitest';
import {
	escape_svelte,
	extensions,
	ogygiaPreprocess,
	normalize_shiki,
	remarkHeadingId,
	wrap_html
} from '../src/content/markdown/index.js';

describe('markdown preset', () => {
	it('exposes .svx / .md extensions', () => {
		expect([...ogygiaPreprocess.extensions]).toEqual(['.svx', '.md']);
		expect([...extensions]).toEqual(['.svx', '.md']);
	});

	it('ogygiaPreprocess() returns an mdsvex preprocessor', () => {
		const pp = ogygiaPreprocess();
		expect(pp).toBeTruthy();
		expect(typeof pp).toBe('object');
	});

	it('normalize_shiki defaults to github dual themes + light-dark()', () => {
		const cfg = normalize_shiki();
		expect(cfg.lightName).toBe('github-light');
		expect(cfg.darkName).toBe('github-dark');
		expect(cfg.defaultColor).toBe('light-dark()');
		expect(cfg.wrapperClass).toBe('code-only');
		expect(cfg.langs).toContain('svelte');
	});
});

describe('escape_svelte / wrap_html', () => {
	it('escapes backticks and ${ for {@html}', () => {
		expect(escape_svelte('`hi` ${x}')).toBe('\\`hi\\` \\${x}');
	});

	it('wraps with class or leaves bare', () => {
		expect(wrap_html('<pre></pre>', 'code-only')).toBe('<div class="code-only"><pre></pre></div>');
		expect(wrap_html('<pre></pre>', false)).toBe('<pre></pre>');
	});
});

describe('remarkHeadingId', () => {
	it('strips {#id} into hProperties.id', () => {
		const tree = {
			type: 'root',
			children: [
				{
					type: 'heading',
					depth: 2,
					children: [{ type: 'text', value: 'Hello {#greet}' }]
				}
			]
		};
		remarkHeadingId()(tree);
		const heading = tree.children[0] as {
			children: Array<{ value: string }>;
			data?: { hProperties?: { id?: string } };
		};
		expect(heading.children[0]?.value).toBe('Hello');
		expect(heading.data?.hProperties?.id).toBe('greet');
	});
});
