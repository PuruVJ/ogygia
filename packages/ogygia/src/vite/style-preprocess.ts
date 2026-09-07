/**
 * A component source made compilable by `svelte.compile` alone, for the build-time tree-CSS
 * collection (`compileFoucScopedCss`): `<style lang="scss|sass">` compiled to CSS, `<script
 * lang="ts">` stripped of TypeScript. The compiler reads neither dialect; without this step such a
 * component's scoped CSS compiles to nothing (or ships raw and unscoped) and a server-rendered
 * subtree styled that way goes unstyled.
 *
 * Node-only (this is the Vite leg): `sass-embedded` or `sass` is resolved from the APP root, the
 * way vitePreprocess finds it (neither installed → the block is left as is, one warning); TS is
 * stripped with Vite's own transform (oxc on Vite ≥ 8, esbuild before).
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const STYLE_BLOCK_G = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_G = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_LANG_ATTR = /\blang\s*=\s*["']?(scss|sass)["']?/i;
const SCRIPT_LANG_TS_ATTR = /\blang\s*=\s*["']?ts["']?/i;

type Sass = { compileString(source: string, options?: Record<string, unknown>): { css: string } };
type Transform = (
	code: string,
	id: string,
	options?: Record<string, unknown>
) => Promise<{ code: string }>;

let sass: Sass | null | undefined;
let sass_warned = false;
let transform: Transform | null | undefined;

function load_sass(root: string): Sass | null {
	if (sass !== undefined) return sass;
	const require = createRequire(path.join(root, 'package.json'));
	for (const name of ['sass-embedded', 'sass']) {
		try {
			sass = require(name) as Sass;
			return sass;
		} catch {
			/* try the next */
		}
	}
	sass = null;
	return sass;
}

async function load_ts_transform(): Promise<Transform | null> {
	if (transform !== undefined) return transform;
	const vite = (await import('vite')) as Record<string, unknown>;
	const oxc = vite.transformWithOxc as
		| ((code: string, id: string, o?: unknown) => Promise<{ code: string }>)
		| undefined;
	const esbuild = vite.transformWithEsbuild as
		| ((code: string, id: string, o?: unknown) => Promise<{ code: string }>)
		| undefined;
	transform = oxc
		? (code, id) => oxc(code, id, { lang: 'ts', typescript: { onlyRemoveTypeImports: true } })
		: esbuild
			? (code, id) =>
					esbuild(code, id, {
						loader: 'ts',
						target: 'esnext',
						tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } }
					})
			: null;
	return transform;
}

/** `source` with `<style lang="scss|sass">` compiled to CSS and `<script lang="ts">` stripped of TS. */
export async function preprocess_component_for_css(
	source: string,
	abs: string,
	root: string
): Promise<string> {
	let out = source;
	if (STYLE_LANG_ATTR.test(out)) {
		const compiler = load_sass(root);
		if (!compiler) {
			if (!sass_warned) {
				sass_warned = true;
				console.warn(
					'[ogygia] a server-rendered component has `<style lang="scss">` but neither `sass-embedded` nor `sass` is installed — its hole/router CSS ships unprocessed'
				);
			}
		} else {
			out = out.replace(STYLE_BLOCK_G, (whole: string, attrs: string, body: string) => {
				const lang = STYLE_LANG_ATTR.exec(attrs)?.[1]?.toLowerCase();
				if (!lang) return whole;
				try {
					const { css } = compiler.compileString(body, {
						syntax: lang === 'sass' ? 'indented' : 'scss',
						loadPaths: [path.dirname(abs), root, path.join(root, 'node_modules')],
						quietDeps: true,
						silenceDeprecations: ['import']
					});
					return `<style${attrs.replace(STYLE_LANG_ATTR, '')}>${css}</style>`;
				} catch (err) {
					console.warn(
						`[ogygia] ${path.relative(root, abs)}: scss compile failed — ${(err as Error).message}`
					);
					return whole;
				}
			});
		}
	}
	if (SCRIPT_LANG_TS_ATTR.test(out)) {
		const ts = await load_ts_transform();
		if (ts) {
			const blocks = [...out.matchAll(SCRIPT_BLOCK_G)];
			for (const m of blocks) {
				const [whole, attrs, body] = m;
				if (!SCRIPT_LANG_TS_ATTR.test(attrs)) continue;
				try {
					const { code } = await ts(body, abs + '.ts');
					out = out.replace(
						whole,
						`<script${attrs.replace(SCRIPT_LANG_TS_ATTR, '')}>${code}</script>`
					);
				} catch (err) {
					console.warn(
						`[ogygia] ${path.relative(root, abs)}: TypeScript strip failed — ${(err as Error).message}`
					);
				}
			}
		}
	}
	return out;
}
