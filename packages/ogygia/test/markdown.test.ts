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

// Run the REAL preprocessor (mdsvex + the full remark/rehype chain) and read back the emitted Svelte.
const render = async (src: string): Promise<string> => {
	const pp = ogygiaPreprocess();
	const out = await pp.markup?.({ content: src, filename: '/x/page.md' });
	return (out as { code: string }).code;
};

/** Pull the `metadata` object literal the module script exports, parsed back to a value. */
const metadataOf = (code: string): { headings: Array<{ depth: number; id: string; text: string }> } => {
	const m = /export const metadata = (\{.*?\});/s.exec(code);
	if (!m) throw new Error('no metadata export found');
	return JSON.parse(m[1]!);
};

describe('code dialect — shiki transformers passthrough', () => {
	it('applies a transformer to every fence (the ecosystem contract)', async () => {
		// A transformer that stamps the <pre> — proof the shiki decoration contract is wired.
		const stamp = { name: 'stamp', pre(node: { properties: Record<string, unknown> }) { node.properties['data-tx'] = 'on'; } };
		const pp = ogygiaPreprocess({ code: { transformers: [stamp] } });
		const out = await pp.markup?.({ content: '```ts\nconst a = 1;\n```', filename: '/x/page.md' });
		expect((out as { code: string }).code).toContain('data-tx="on"');
	});

	it('a variant generator produces a multi-variant switcher (both versions inline)', async () => {
		const casing = {
			pref: { name: 'case', values: ['lower', 'upper'], default: 'lower' },
			generate: (f: { lang: string; source: string }) =>
				f.lang === 'bash'
					? [
							{ label: 'lower', value: 'lower', fence: f },
							{ label: 'UPPER', value: 'upper', fence: { ...f, source: f.source.toUpperCase() } }
						]
					: null
		};
		const pp = ogygiaPreprocess({ code: { variants: [casing as never] } });
		const out = await pp.markup?.({ content: '```bash\necho hi\n```', filename: '/x/page.md' });
		const c = (out as { code: string }).code; // inside {@html `...`}; only backtick/backslash/${ are escaped, not "
		expect(c).toContain('class="og-code"');
		expect(c).toContain('data-pref="case"');
		expect(c).toContain('data-pref-set="upper"');
		// two variant panels inline, and the UPPER variant's uppercased token is present (shiki splits
		// tokens into spans, so assert on the distinguishing token, not the whole line)
		expect((c.match(/class="og-variant"/g) ?? []).length).toBe(2);
		expect(c).toContain('ECHO');
		expect((c.match(/class="og-variant-btn"/g) ?? []).length).toBe(2);
	});

	it('a plain fence (no variant claims it) stays the single-variant path', async () => {
		const casing = { pref: { name: 'case', values: ['a', 'b'], default: 'a' }, generate: (f: { lang: string }) => (f.lang === 'bash' ? [{ label: 'a', value: 'a', fence: f }, { label: 'b', value: 'b', fence: f }] : null) };
		const pp = ogygiaPreprocess({ code: { variants: [casing as never] } });
		const out = await pp.markup?.({ content: '```ts\nconst a = 1;\n```', filename: '/x/page.md' });
		expect((out as { code: string }).code).not.toContain('og-code');
		expect((out as { code: string }).code).toContain('data-lang="ts"');
	});

	it('passes the raw fence infostring to transformers as meta.__raw (so {1-3} line highlight works)', async () => {
		// A transformer that echoes the raw meta it received — proves the __raw passthrough.
		const echo = {
			name: 'echo-meta',
			pre(this: { options: { meta?: { __raw?: string } } }, node: { properties: Record<string, unknown> }) {
				node.properties['data-raw'] = this.options.meta?.__raw ?? '';
			}
		};
		const pp = ogygiaPreprocess({ code: { transformers: [echo] } });
		const out = await pp.markup?.({ content: '```js {1,3}\nconst a = 1;\n```', filename: '/x/page.md' });
		expect((out as { code: string }).code).toContain('data-raw="{1,3}"');
	});
});

describe('prose dialect — remark/rehype passthrough', () => {
	it('runs a user remark plugin after the built-in passes', async () => {
		// A tiny remark plugin that uppercases text nodes — proof the ecosystem contract is wired.
		const shout = () => (tree: { children?: unknown[] }) => {
			const walk = (n: { type?: string; value?: string; children?: unknown[] }) => {
				if (n.type === 'text' && typeof n.value === 'string') n.value = n.value.toUpperCase();
				(n.children as Array<typeof n> | undefined)?.forEach(walk);
			};
			walk(tree as { children?: unknown[] });
		};
		const pp = ogygiaPreprocess({ remark: [shout] });
		const out = await pp.markup?.({ content: '# hello world', filename: '/x/page.md' });
		expect((out as { code: string }).code).toContain('HELLO WORLD');
	});

	it('runs a user rehype plugin (adds an attribute to an element)', async () => {
		const stamp = () => (tree: unknown) => {
			const walk = (n: { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
				if (n.type === 'element' && n.tagName === 'h1') (n.properties ??= {})['data-stamped'] = 'yes';
				(n.children as Array<typeof n> | undefined)?.forEach(walk);
			};
			walk(tree as Parameters<typeof walk>[0]);
		};
		const pp = ogygiaPreprocess({ rehype: [stamp] });
		const out = await pp.markup?.({ content: '# hi', filename: '/x/page.md' });
		expect((out as { code: string }).code).toContain('data-stamped="yes"');
	});
});

describe('scoped heading ids', () => {
	it('joins the ancestor path for auto-slugged headings', async () => {
		const code = await render(['# A', '', '## B', '', '### C', '', '## D'].join('\n'));
		expect(code).toContain('<h1 id="a">');
		expect(code).toContain('id="a-b"');
		expect(code).toContain('id="a-b-c"');
		expect(code).toContain('id="a-d"');
		// The `### C` under the FIRST `## B` must not leak into the later `## D` scope.
		expect(code).not.toContain('id="a-d-c"');
	});

	it('metadata.headings carries the SAME scoped ids', async () => {
		const code = await render(['# A', '', '## B', '', '### C', '', '## D'].join('\n'));
		const { headings } = metadataOf(code);
		// h1 is outside the default collect range (min 2) but still scopes its descendants.
		expect(headings).toEqual([
			{ depth: 2, id: 'a-b', text: 'B' },
			{ depth: 3, id: 'a-b-c', text: 'C' },
			{ depth: 2, id: 'a-d', text: 'D' }
		]);
	});

	it('keeps an explicit {#id} verbatim and scopes its children under it', async () => {
		const code = await render(['## Setup {#install}', '', '### Step'].join('\n'));
		expect(code).toContain('id="install"'); // verbatim, NOT the `setup` slug, NOT prefixed
		expect(code).not.toContain('id="setup"');
		expect(code).toContain('id="install-step"'); // child scopes under the explicit id
	});

	it('de-dupes colliding scoped ids with a numeric suffix', async () => {
		const code = await render(['# A', '', '## B', '', '## B'].join('\n'));
		expect(code).toContain('id="a-b"');
		expect(code).toContain('id="a-b-1"');
	});
});

describe('code-block ids', () => {
	const FENCE = ['```ts', 'const x = 1;', '```'].join('\n');

	it('stamps a scoped `slug-code-<hash>` id onto the <pre> in the SSR HTML', async () => {
		const code = await render(['## Install', '', FENCE].join('\n'));
		expect(code).toMatch(/<pre [^>]*id="install-code-[a-z0-9]+"/);
	});

	it('uses a bare `code-<hash>` id for a block before any heading', async () => {
		const code = await render([FENCE, '', '## Later'].join('\n'));
		// No heading precedes it, so no slug prefix.
		expect(code).toMatch(/<pre [^>]*id="code-[a-z0-9]+"/);
		expect(code).not.toMatch(/id="install-code-/);
	});

	it('gives two identical blocks in one section distinct ids', async () => {
		const code = await render(['## Install', '', FENCE, '', FENCE].join('\n'));
		const ids = [...code.matchAll(/<pre [^>]*id="(install-code-[a-z0-9-]+)"/g)].map((m) => m[1]);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2); // distinct
		expect(ids[1]).toBe(`${ids[0]}-2`); // second identical block gets the -2 suffix
	});

	it('is a stable content hash — the id survives inserting a block earlier in the section', async () => {
		const a = await render(['## Install', '', FENCE].join('\n'));
		const b = await render(
			['## Install', '', '```ts', 'const other = 9;', '```', '', FENCE].join('\n')
		);
		const idsOf = (code: string) =>
			[...code.matchAll(/<pre [^>]*id="(install-code-[a-z0-9]+)"/g)].map((m) => m[1]);
		const [only] = idsOf(a); // doc A has the one `const x = 1;` block
		// Inserting a different block BEFORE it in the same section must not retire its content-hash id.
		expect(idsOf(b)).toContain(only);
	});
});

describe('tab component injection (plain barrel)', () => {
	// TabGroup is a plain, overridable wrapper (its internal island carries the `wake`), so the injected
	// import is an ordinary barrel — no island mark, no `ogygia/content/tab-group` specifier, no upgrade.
	const INJECTED = `import { TabGroup, Tab } from 'ogygia/content';`;
	const CODE_GROUP = [
		'::: code-group',
		'```bash [npm]',
		'npm i ogygia',
		'```',
		'```bash [pnpm]',
		'pnpm add ogygia',
		'```',
		':::'
	].join('\n');

	/** The instance-script (non-module) blocks of the compiled module. */
	const instance_scripts = (code: string) =>
		[...code.matchAll(/<script\b(?![^>]*\bmodule\b)[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0]);

	it('::: code-group injects the plain TabGroup + Tab barrel import', async () => {
		const code = await render(['# T', '', CODE_GROUP].join('\n'));
		expect(code).toContain(INJECTED);
		// plain wrapper — never the island-mark form
		expect(code).not.toContain('ogygia/content/tab-group');
		expect(code).not.toMatch(/import \{[^}]*Tab[^}]*\}[^\n]*with \{/);
		// injected exactly once
		expect(code.split(INJECTED)).toHaveLength(2);
	});

	it('does not inject when no tab syntax is used', async () => {
		const code = await render('# Plain page\n\nNo tabs here.');
		expect(code).not.toContain(INJECTED);
	});

	it("leaves an author's `import { TabGroup, Tab } from 'ogygia/content'` untouched (no upgrade)", async () => {
		const code = await render(
			[
				'<script>',
				"\timport { TabGroup, Tab } from 'ogygia/content';",
				'</script>',
				'',
				'<TabGroup group="pm"><Tab label="npm">hi</Tab></TabGroup>'
			].join('\n')
		);
		// TabGroup is a plain component — the author import stays a plain barrel, never split or marked
		expect(code).toMatch(/import \{ TabGroup, Tab \} from 'ogygia\/content';/);
		expect(code).not.toContain('ogygia/content/tab-group');
		expect(code).not.toMatch(/with \{/);
	});

	it('author import + ::: syntax → not double-injected', async () => {
		const code = await render(
			[
				'<script>',
				"\timport { TabGroup, Tab } from 'ogygia/content';",
				'</script>',
				'',
				'<TabGroup group="pm"><Tab label="npm">hi</Tab></TabGroup>',
				'',
				CODE_GROUP
			].join('\n')
		);
		// the author already imports the pair → the `:::` pass must not inject a second barrel import
		expect(code.match(/import \{ TabGroup, Tab \} from 'ogygia\/content';/g)).toHaveLength(1);
	});

	it('an import inside a fenced code SAMPLE is not treated as a real import (Shiki escapes it)', async () => {
		const code = await render(
			['# T', '', '```svelte', '<script>', "\timport { TabGroup, Tab } from 'ogygia/content';", '</script>', '```'].join('\n')
		);
		expect(code).not.toContain('ogygia/content/tab-group');
	});

	it('leaves sibling barrel specifiers untouched (no split)', async () => {
		const code = await render(
			[
				'<script>',
				"\timport { Doc, TabGroup, Tab } from 'ogygia/content';",
				'</script>',
				'',
				'<TabGroup group="pm"><Tab label="npm">hi</Tab></TabGroup>'
			].join('\n')
		);
		expect(code).toMatch(/import \{ Doc, TabGroup, Tab \} from 'ogygia\/content';/);
		expect(code).not.toContain('ogygia/content/tab-group');
	});
});
