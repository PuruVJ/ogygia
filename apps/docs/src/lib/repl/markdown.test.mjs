// Deterministic unit coverage for the Observatory's markdown pipeline — ogygia's REAL content transform
// (mdsvex + Shiki + admonitions + heading ids/anchors + frontmatter) run in a browser-host realm, plus
// the full rolldown bundle of a `.md` entry. No network, no browser. Run: `node markdown.test.mjs`.
import { rolldown } from 'rolldown';
import { compile } from 'svelte/compiler';
import { set_host } from 'ogygia/internal/compiler-browser';
import { make_browser_host } from './browser-host.ts';
import { md_to_svelte, markdownPlugin } from './markdown-plugin.ts';
import { sveltePlugin } from './svelte-plugin.ts';
import { cdnPlugin } from './cdn-plugin.ts';

set_host(make_browser_host());

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

const svelteFor = (md) => md_to_svelte(md, '/repl/src/routes/+page.md');
/** md → svelte source → both compile legs must succeed (proves the emitted svelte is valid). */
async function compiles(md) {
	const src = await svelteFor(md);
	compile(src, { filename: '+page.md', generate: 'server', dev: false });
	compile(src, { filename: '+page.md', generate: 'client', dev: false });
	return src;
}
/** Full REPL bundle of a `.md` entry (workspace + markdown + svelte + cdn). */
async function bundle(md, extraFiles = {}) {
	const files = { '/repl/src/routes/+page.md': md, ...extraFiles };
	// Mirror the worker's resolve_file for the bits the tests exercise: exact key, `$lib/…` → src/lib,
	// and a bare basename → the matching file.
	const resolve = (id) => {
		if (files[id] != null) return id;
		if (id.startsWith('$lib/')) { const k = '/repl/src/lib/' + id.slice(5); if (files[k] != null) return k; }
		const base = id.split('/').pop();
		return Object.keys(files).find((k) => k.split('/').pop() === base) ?? null;
	};
	const ws = { name: 'ws', resolveId(id) { return resolve(id); }, load(id) { return files[id] ?? null; } };
	const b = await rolldown({
		input: '/repl/src/routes/+page.md',
		plugins: [ws, markdownPlugin({ generate: 'client' }), sveltePlugin({ generate: 'client' }), cdnPlugin({ fetchTimeout: 8000 })],
		external: (id) => /^svelte(\/|$)/.test(id) || /^ogygia(\/|$)/.test(id),
		cwd: '/', onLog() {}
	});
	const { output } = await b.generate({ format: 'cjs', exports: 'named' });
	return output[0].code;
}

async function main() {
	console.log('markdown pipeline (browser host)\n');

	// frontmatter → metadata export
	{
		const src = await svelteFor(`---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n`);
		ok('frontmatter → metadata export', /export const metadata/.test(src) && /"title":"Hello"/.test(src));
	}
	// heading id + hover anchor
	{
		const src = await svelteFor(`## My Heading\n`);
		ok('heading gets a slug id', /id="my-heading"/.test(src));
		ok('heading gets a hover anchor', /og-heading-anchor/.test(src));
	}
	// admonitions (each kind → pure HTML, no runtime import). `note`/`caution` are VitePress ALIASES
	// (note→info, caution→warning), so assert the resolved class per kind.
	for (const [kind, cls] of [['tip', 'tip'], ['warning', 'warning'], ['danger', 'danger'], ['info', 'info'], ['important', 'important'], ['note', 'info'], ['caution', 'warning']]) {
		const src = await svelteFor(`::: ${kind}\nbody\n:::\n`);
		ok(`admonition ::: ${kind} → og-admonition-${cls} (no import)`, new RegExp(`og-admonition-${cls}`).test(src) && !/from 'ogygia/.test(src));
	}
	// collapsible details admonition (with title)
	{
		const src = await svelteFor(`::: details Click me\nhidden\n:::\n`);
		ok('::: details → <details> with summary', /<details/.test(src) && /Click me/.test(src));
	}
	// shiki fences (js + ts), highlighted
	{
		const src = await svelteFor('```js\nconst x = 1;\n```\n');
		ok('js fence → shiki highlight', /class="[^"]*shiki/.test(src) && /const/.test(src));
		const ts = await svelteFor('```ts\nconst n: number = 1;\n```\n');
		ok('ts fence → shiki highlight', /class="[^"]*shiki/.test(ts));
	}
	// table
	{
		const src = await svelteFor(`| a | b |\n| - | - |\n| 1 | 2 |\n`);
		ok('markdown table → <table>', /<table/.test(src));
	}
	// inline: bold, link, inline code
	{
		const src = await svelteFor(`**bold** [link](/x) \`code\`\n`);
		ok('inline bold/link/code render', /<strong>bold<\/strong>/.test(src) && /href="\/x"/.test(src) && /<code>code<\/code>/.test(src));
	}
	// the `?raw` self-source export is stripped (unbundlable in the REPL)
	{
		const src = await svelteFor(`# X\n`);
		ok('__ogygia_source (?raw) line stripped', !/__ogygia_source/.test(src) && !/\?raw/.test(src));
	}
	// tabs / code-group inject the ogygia island wrappers (kept external, passthrough at mount)
	{
		const src = await svelteFor(`::: tabs\n== A\nfoo\n== B\nbar\n:::\n`);
		ok('::: tabs → TabGroup/Tab from ogygia/content', /import \{ TabGroup, Tab \} from 'ogygia\/content'/.test(src) && /<TabGroup/.test(src));
	}
	// resilience: empty + frontmatter-only + a lone heading all produce valid, compilable svelte
	for (const [label, md] of [['empty', ''], ['frontmatter-only', '---\ntitle: T\n---\n'], ['heading-only', '# H\n'], ['html-in-md', '<div>raw</div>\n\n# After\n']]) {
		try { await compiles(md); ok(`compiles: ${label}`, true); }
		catch (e) { ok(`compiles: ${label}`, false, e.message.split('\n')[0]); }
	}

	// full bundle: a content entry bundles to a mountable CJS module with the rendered markup inlined
	{
		const code = await bundle(`# Live\n\n::: tip\nhi\n:::\n\n\`\`\`js\nconst a=1;\n\`\`\`\n`);
		ok('full bundle: mountable module with admonition + shiki inlined', code.length > 0 && /og-admonition/.test(code) && /shiki/.test(code));
	}
	// full bundle with tabs keeps ogygia/content external (require, not CDN-fetched)
	{
		const code = await bundle(`::: tabs\n== A\naaa\n== B\nbbb\n:::\n`);
		ok('full bundle: tabs keep ogygia/content external (require, not fetched)', /require\(["']ogygia\/content["']\)/.test(code));
	}
	// full bundle: a content page importing a workspace component (island dial stripped → plain import)
	{
		const counter = `<script>let { start = 0 } = $props(); let n = $state(start);</script>\n<button onclick={() => n++}>c {n}</button>`;
		const code = await bundle(
			`<script>\n  import Counter from '$lib/Counter.svelte' with { wake: 'load' };\n</script>\n\n# With island\n\n<Counter start={2} />\n`,
			{ '/repl/src/lib/Counter.svelte': counter }
		);
		ok('full bundle: island-in-content links the workspace component', code.length > 0 && /button/.test(code));
	}

	console.log(`\n${'─'.repeat(44)}`);
	console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
