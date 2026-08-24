import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { compile } from 'svelte/compiler';

// ─────────────────────────────────────────────────────────────────────────────
// The profiler UI ships as raw `.svelte` files in dist and is compiled by the
// CONSUMER's Svelte pipeline (rendered through document(), hydrated as islands).
// That pipeline preprocesses the SCRIPT and STYLE blocks but NOT template markup,
// so any TypeScript-only syntax in a `{…}` expression survives preprocessing and
// then blows up `svelte.compile` in the consumer's build (they hit exactly this:
// `Report.svelte: Expected token }` on `{meta.runs!.length}`, and a postcss
// "Unknown word PROFILER_STYLE" from a `<style>` literal caught in a script string).
//
// This test reproduces the consumer faithfully: transpile each script TS→JS (drop
// `lang="ts"`, as vitePreprocess+esbuild does), then compile for client AND server.
// A TS non-null assertion or `as` cast left in the markup fails here just like it
// fails in their CI. It's the guard that keeps the profiler UI portable.
// ─────────────────────────────────────────────────────────────────────────────

const ui_dir = fileURLToPath(new URL('../src/profiler/ui/', import.meta.url));
const files = readdirSync(ui_dir).filter((f) => f.endsWith('.svelte'));

/** Strip TS from the `<script lang="ts">` body and drop the lang attr — what the consumer's
 *  preprocess does before Svelte ever sees the file. Markup is left untouched (as it is in reality). */
function to_consumer_js(source: string): string {
	return source.replace(
		/<script\b([^>]*)\blang=["']ts["']([^>]*)>([\s\S]*?)<\/script>/g,
		(_m, pre: string, post: string, body: string) => {
			const js = ts.transpileModule(body, {
				compilerOptions: {
					target: ts.ScriptTarget.ESNext,
					module: ts.ModuleKind.ESNext,
					verbatimModuleSyntax: false,
					isolatedModules: true
				}
			}).outputText;
			return `<script${pre}${post}>\n${js}</script>`;
		}
	);
}

describe('profiler UI is consumer-compilable (no TS in template markup)', () => {
	it('found the profiler UI components', () => {
		expect(files.length).toBeGreaterThan(5);
		expect(files).toContain('Report.svelte');
		expect(files).toContain('Shell.svelte');
	});

	for (const f of files) {
		it(`${f} compiles after the consumer strips script TS`, () => {
			const src = readFileSync(ui_dir + f, 'utf8');
			const js = to_consumer_js(src);
			// both generate targets — the consumer builds SSR (server) and hydration (client)
			expect(() => compile(js, { filename: f, generate: 'server' })).not.toThrow();
			expect(() => compile(js, { filename: f, generate: 'client' })).not.toThrow();
		});
	}

	// A `<style>…</style>` literal anywhere in a <script> block gets regex-scanned as a real style
	// element by some preprocess pipelines, which then feed its (non-CSS) contents to postcss. Keep the
	// substring out of scripts entirely (Shell.svelte builds the tag from a variable).
	for (const f of files) {
		it(`${f} has no <style> literal inside a <script> block`, () => {
			const src = readFileSync(ui_dir + f, 'utf8');
			const scripts = src.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
			for (const block of scripts) {
				expect(block, `${f} script block contains a literal <style> tag`).not.toMatch(/<\/?style>/);
			}
		});
	}
});
