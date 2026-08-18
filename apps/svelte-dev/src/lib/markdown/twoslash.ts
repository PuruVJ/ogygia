/**
 * Twoslash — typed hover tooltips in code fences, as VALUES against ogygia's fence-pipeline
 * `code.transformers` contract. svelte.dev runs twoslash on js/ts only; we go one further and run it
 * on `.svelte` fences too via `twoslash-svelte` (svelte2tsx under the hood). Everything here is a
 * Shiki transformer or a small source-rewrite, so it slots into the existing pipeline with no core
 * change — twoslash's output rides the same fence cache as any other rendered fence.
 *
 * Three transformers, applied in this order (Shiki runs `preprocess` in array order):
 *   1. {@link twoslash_banner} — prepends ambient svelte/kit globals + `// ---cut---` so a bare
 *      snippet (`let count = $state(0)`) typechecks without imports and the setup stays hidden.
 *   2/3. the twoslash transformers — plain (js/ts) and svelte, each lang-filtered so they self-select.
 *
 * Type resolution is against the APP's own `node_modules` (it depends on svelte + @sveltejs/kit), so
 * no separate types package. Errors don't fail the build: `throws: false` renders best-effort, and
 * the corpus's own `// @errors` / `// @noErrors` / `// ---cut---` directives are consumed natively
 * (which is why the `twoslash_strip` meta parser comes OUT of the chain when twoslash is on).
 */
import ts from 'typescript';
import type { ShikiTransformer } from 'shiki';
import { createTransformerFactory, rendererRich } from '@shikijs/twoslash';
import { createTwoslasher } from 'twoslash';
import { createTwoslasherSvelte } from 'twoslash-svelte';
import { fromMarkdown } from 'mdast-util-from-markdown';

/** Absolute app root — its `node_modules` is twoslash's VFS (svelte + @sveltejs/kit `.d.ts` live there). */
const vfsRoot = process.cwd();

const compilerOptions = {
	allowJs: true,
	checkJs: true,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	target: ts.ScriptTarget.ESNext,
	types: ['svelte', '@sveltejs/kit']
};

// ── banner: make bare snippets typecheck ─────────────────────────────────────────

/** Ambient references + virtual-module shims prepended (and hidden by `---cut---`) so a snippet that
 *  uses runes / `$app/*` / `$env/*` / `./$types` resolves without the author writing imports. */
function banner_for(lang: string, source: string): string {
	const lines: string[] = ['// @filename: injected.d.ts', '/// <reference types="svelte" />'];

	if (/\$app\/|@sveltejs\/kit|\$service-worker/.test(source)) {
		lines.push('/// <reference types="@sveltejs/kit" />');
	}
	// `$lib/*` imports have no real module in the VFS — shim each as `any` so the snippet resolves
	// (svelte.dev does the same). Covers `import … from '$lib/foo'`.
	for (const m of source.matchAll(/from\s+['"](\$lib\/[^'"]+)['"]/g)) {
		lines.push(`declare module '${m[1]}' { const x: any; export = x; export default x; }`);
	}
	if (source.includes('$env/')) {
		lines.push(
			`declare module '$env/dynamic/private' { export const env: Record<string, string>; }`,
			`declare module '$env/dynamic/public' { export const env: Record<string, string>; }`,
			`declare module '$env/static/private' { export const API_KEY: string; }`,
			`declare module '$env/static/public' { export const PUBLIC_URL: string; }`
		);
	}
	if (source.includes('./$types') && !source.includes('@filename: $types')) {
		lines.push(
			`// @filename: $types.d.ts`,
			`import type * as Kit from '@sveltejs/kit';`,
			`export type PageLoad = Kit.Load<Record<string, any>>;`,
			`export type PageServerLoad = Kit.ServerLoad<Record<string, any>>;`,
			`export type LayoutLoad = Kit.Load<Record<string, any>>;`,
			`export type LayoutServerLoad = Kit.ServerLoad<Record<string, any>>;`,
			`export type RequestHandler = Kit.RequestHandler<Record<string, any>>;`,
			`export type Actions = Kit.Actions<Record<string, any>>;`,
			`export type PageProps = { data: Record<string, any>; form: any };`,
			`export type LayoutProps = { data: Record<string, any>; children: any };`,
			`export type EntryGenerator = () => Promise<Array<Record<string, string>>> | Array<Record<string, string>>;`
		);
	}

	// The snippet's own virtual file, then the display cut. A `.d.ts`/`.svelte`/`.ts`/`.js` name tells
	// twoslash how to treat the main file; svelte fences MUST be `.svelte` for twoslash-svelte.
	const main = lang === 'svelte' ? 'App.svelte' : lang === 'ts' ? 'index.ts' : 'index.js';
	lines.push(`// @filename: ${main}`, '// ---cut---');
	return lines.join('\n') + '\n';
}

/** The marker line twoslash's cut consumes on success. If it survives to the rendered HTML, twoslash
 *  did NOT run (it failed / was re-entrant) — the safety net below strips the banner so it never shows. */
const CUT = '// ---cut---';

/**
 * RE-ENTRANCY GUARD. `@shikijs/twoslash`'s rendererRich re-highlights each hover popup's type
 * signature through the SAME shiki instance — which re-invokes THIS transformer on popup content,
 * prepending a banner to a bare type sig and re-running twoslash (the `highlightPopupContent`
 * crash). A module-flag set for the outer fence's lifetime (preprocess → the `root` hook, which
 * fires once at the very end) makes the banner and the twoslash transformers inert on those nested
 * popup renders. Build highlighting is effectively sequential per fence (twoslash is synchronous),
 * so a single flag is safe.
 */
let depth = 0;

/** True on a NESTED render (a rendererRich popup) — depth 1 is the outer fence, >1 is re-entrant. */
export function is_reentrant(): boolean {
	return depth > 1;
}

/** Prepend the banner before the twoslash transformers see the code, and guarantee it never shows:
 *  - `preprocess` prepends (top-level only) and arms the re-entrancy flag;
 *  - `root` disarms it AND, if a `---cut---` survived (twoslash didn't run), strips every line up to
 *    and including it so the banner can't leak into the page. */
export function twoslash_banner(): ShikiTransformer {
	return {
		name: 'svelte-dev:twoslash-banner',
		preprocess(code, options) {
			const lang = options.lang;
			depth++; // entered a render (outer fence → 1, nested popup → >1); `root` unwinds it
			if (depth > 1) return undefined; // nested popup render — leave it plain
			if (lang !== 'js' && lang !== 'ts' && lang !== 'svelte') return undefined;
			return banner_for(lang, code) + code;
		},
		root(root) {
			depth = Math.max(0, depth - 1);
			if (depth > 0) return; // unwinding a nested popup — the strip is the outer fence's job
			// Safety net: if the cut marker reached the tree, twoslash never consumed it → drop the
			// banner lines (everything through the last cut) so setup code is never displayed.
			const pre = find_pre(root);
			if (!pre) return;
			const code = pre.children.find((n: any) => n.type === 'element' && n.tagName === 'code');
			if (!code) return;
			const lines: any[] = code.children;
			let cut = -1;
			for (let i = lines.length - 1; i >= 0; i--) {
				if (node_text(lines[i]).includes(CUT)) {
					cut = i;
					break;
				}
			}
			if (cut === -1) return;
			// Lines are `<span class="line">…</span>` separated by text nodes ("\n"); drop through the
			// cut line and the newline that follows it.
			code.children = lines.slice(cut + 2);
		}
	};
}

/** The `<pre>` element of a shiki hast root (skip whitespace text nodes). */
function find_pre(root: any): any {
	for (const n of root.children ?? []) {
		if (n.type === 'element' && n.tagName === 'pre') return n;
		if (n.type === 'element') {
			const inner = find_pre(n);
			if (inner) return inner;
		}
	}
	return null;
}

/** Concatenated text content of a hast node. */
function node_text(node: any): string {
	if (!node) return '';
	if (node.type === 'text') return node.value;
	return (node.children ?? []).map(node_text).join('');
}

// ── the twoslash transformers ────────────────────────────────────────────────────

const shared = {
	renderer: rendererRich(),
	twoslashOptions: { compilerOptions },
	throws: false,
	// twoslash skips `.js` by default; run on everything the lang filter admits.
	filter: () => true
} as const;

/** Make a twoslash transformer inert on nested popup re-highlights (see {@link is_reentrant}). A
 *  transformer that runs on rendererRich's own popup content would recurse; here `preprocess` bails
 *  out with the code untouched, so no twoslash hooks fire for that nested call. */
function guard(t: ShikiTransformer): ShikiTransformer {
	const inner = t.preprocess;
	return {
		...t,
		preprocess(this: unknown, code: string, options: Parameters<NonNullable<ShikiTransformer['preprocess']>>[1]) {
			if (is_reentrant()) return undefined;
			return inner?.call(this, code, options);
		}
	};
}

/** Plain twoslash for `js` / `ts` fences (and the JS→TS toggle's TS variant). */
export function twoslash_ts(): ShikiTransformer {
	const factory = createTransformerFactory(createTwoslasher({ vfsRoot }), rendererRich());
	return guard(factory({ ...shared, langs: ['js', 'ts'] }));
}

/** twoslash-svelte for `.svelte` fences — type hovers on component code, beyond svelte.dev. */
export function twoslash_svelte(): ShikiTransformer {
	const factory = createTransformerFactory(createTwoslasherSvelte({ vfsRoot }), rendererRich());
	return guard(factory({ ...shared, langs: ['svelte'] }));
}

// ── popup JSDoc → markdown ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
function decode(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
		.replace(/&(?:lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m] ?? m);
}
function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function esc_attr(s: string): string {
	return esc(s).replace(/"/g, '&quot;');
}

/** Serialize the small mdast node set that appears in JSDoc popups. Escapes text; anything exotic
 *  falls back to its text content — a tooltip never renders arbitrary HTML. */
function mdast_to_html(node: any): string {
	const kids = (n: any) => (n.children ?? []).map(mdast_to_html).join('');
	switch (node.type) {
		case 'root':
			return kids(node);
		case 'paragraph':
			return `<p>${kids(node)}</p>`;
		case 'text':
			return esc(node.value);
		case 'strong':
			return `<strong>${kids(node)}</strong>`;
		case 'emphasis':
			return `<em>${kids(node)}</em>`;
		case 'inlineCode':
			return `<code>${esc(node.value)}</code>`;
		case 'code':
			return `<pre><code>${esc(node.value)}</code></pre>`;
		case 'link':
			// Hover links leave the docs (MDN, external refs) — open in a new tab, safely.
			return `<a href="${esc_attr(node.url)}" target="_blank" rel="noopener noreferrer">${kids(node)}</a>`;
		case 'break':
			return '<br>';
		case 'list':
			return node.ordered ? `<ol>${kids(node)}</ol>` : `<ul>${kids(node)}</ul>`;
		case 'listItem':
			return `<li>${kids(node)}</li>`;
		default:
			return kids(node);
	}
}

/**
 * rendererRich emits a hover's JSDoc as RAW markdown text in `.twoslash-popup-docs` (`**bold**`,
 * `` `code` ``, `[text](url)`). A `postprocess` (last in the chain) decodes the entities and runs it
 * through the markdown parser the rest of the corpus uses (micromark, via `mdast-util-from-markdown`)
 * so the tooltip shows formatted prose + working reference links — the pass svelte.dev applies too.
 * Sync, so it needs no async fence hook; a fence with no popup is a no-op.
 */
export function twoslash_popup_markdown(): ShikiTransformer {
	return {
		name: 'svelte-dev:twoslash-popup-markdown',
		postprocess(html) {
			if (!html.includes('twoslash-popup-docs')) return undefined;
			return html.replace(
				/<div class="twoslash-popup-docs([^"]*)">([\s\S]*?)<\/div>/g,
				(_m, cls: string, inner: string) => {
					// The `-tags` block is structured HTML (params/examples) — leave it; only prose is markdown.
					if (cls.includes('twoslash-popup-docs-tags')) return `<div class="twoslash-popup-docs${cls}">${inner}</div>`;
					const rendered = mdast_to_html(fromMarkdown(decode(inner)));
					return `<div class="twoslash-popup-docs${cls}">${rendered}</div>`;
				}
			);
		}
	};
}
