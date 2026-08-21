import { describe, expect, it } from 'vitest';
import { try_region_emit, unescape_svelte } from '../src/content/markdown/region-emit.js';
import { escape_svelte, fence_embed } from '../src/content/markdown/shiki.js';

/** A compiled-module skeleton: module script (metadata) + template markup. */
const mod = (template: string, script = `export const metadata = {"title":"X"};`) =>
	`<script context="module">\n${script}\n</script>\n${template}`;

describe('unescape_svelte', () => {
	it('is the exact inverse of escape_svelte', () => {
		const nasty = 'a `tick` and \\ backslash and ${interp} and \\` mixed \\\\${end}';
		expect(unescape_svelte(escape_svelte(nasty))).toBe(nasty);
	});

	it('round-trips real fence HTML through the embed codec', () => {
		const html = `<pre class="shiki"><code>const x = \`hi \${name}\`; // {braces}</code></pre>`;
		const embedded = fence_embed(html);
		const m = /\{@html `([\s\S]*)`\}/.exec(embedded)!;
		expect(unescape_svelte(m[1]!)).toBe(html);
	});
});

describe('try_region_emit', () => {
	it('emits a serialized region for pure prose + fences', () => {
		const fence = fence_embed(
			`<pre class="shiki"><code>function load() { return { user }; }</code></pre>`
		);
		const out = try_region_emit(
			mod(`<h2 id="a">Title</h2>\n<p>prose</p>\n${fence}\n<p>after</p>`),
			[]
		);
		expect(out).not.toBeNull();
		// The document HTML is plain — fences unwrapped, braces intact INSIDE code.
		expect(out!.html).toContain('function load() { return { user }; }');
		expect(out!.html).toContain('<h2 id="a">Title</h2>');
		expect(out!.html).not.toContain('{@html `');
		// The module: metadata kept verbatim, region export added, template is one reference.
		expect(out!.code).toContain('export const metadata =');
		expect(out!.code).toContain('export const __ogygia_region =');
		expect(out!.code.trim().endsWith('{@html __ogygia_region.html}')).toBe(true);
	});

	it('keeps extra module lines (the source self-import)', () => {
		const line = `export const __ogygia_source = () => import('./x.md?raw');`;
		const out = try_region_emit(mod('<p>hi</p>'), [line]);
		expect(out!.code).toContain(line);
	});

	it('does not confuse digits in prose with fence tokens', () => {
		const fence = fence_embed('<pre>CODE</pre>');
		const out = try_region_emit(mod(`<p>step 0 of 1 then 2</p>\n${fence}`), []);
		expect(out!.html).toContain('step 0 of 1 then 2');
		expect(out!.html.match(/CODE/g)!.length).toBe(1);
	});

	it('JSON-escapes </script> in content so the module script cannot terminate early', () => {
		const fence = fence_embed('<pre>&lt;/script&gt; but also raw: </pre>');
		const out = try_region_emit(mod(`<p>x</p>\n${fence}`), []);
		// the JSON literal in the emitted code never contains a raw `<`
		const json_part = /__ogygia_region = \{ html: ("(?:[^"\\]|\\.)*") \};/.exec(out!.code)!;
		expect(json_part[1]!).not.toContain('<');
		expect(JSON.parse(json_part[1]!)).toBe(out!.html);
	});

	it('escapes prose braces to entities (text, not expressions — md is content)', () => {
		const out = try_region_emit(mod('<p>count is {count}, show a brace: {</p>'), []);
		expect(out).not.toBeNull();
		expect(out!.html).toContain('count is &#123;count&#125;, show a brace: &#123;');
		expect(out!.html).not.toMatch(/[{}]/);
	});

	it('falls back only on instance scripts; inert tags stay content', () => {
		// a real script is genuinely dynamic — the component path's job
		expect(try_region_emit(mod('<script>let a = 1;</script><p>x</p>'), [])).toBeNull();
		// a capitalized tag can't be a component here (no imports) — passes through inert
		const cap = try_region_emit(mod('<p>use <Widget /> for this</p>'), []);
		expect(cap).not.toBeNull();
		expect(cap!.html).toContain('<Widget />');
		// svelte: meta-elements can't exist here either — escaped to visible text
		const meta = try_region_emit(mod('<p>Add <svelte:document> (3.57.0)</p>'), []);
		expect(meta).not.toBeNull();
		expect(meta!.html).toContain('&lt;svelte:document>');
		const closed = try_region_emit(mod('<p><svelte:head>x</svelte:head></p>'), []);
		expect(closed!.html).toContain('&lt;svelte:head>x&lt;/svelte:head>');
	});

	it('allows braces inside fence content (code is code)', () => {
		const fence = fence_embed('<pre><code>{#each items as item}</code></pre>');
		const out = try_region_emit(mod(`<p>plain</p>\n${fence}`), []);
		expect(out).not.toBeNull();
		expect(out!.html).toContain('{#each items as item}');
	});

	it('handles a module with no module script (frontmatter-less md)', () => {
		const out = try_region_emit('<p>bare</p>', []);
		expect(out).not.toBeNull();
		expect(out!.html).toBe('<p>bare</p>');
		expect(out!.code).toContain('__ogygia_region');
	});
});
