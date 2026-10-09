import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { strip_markup_ts } from '@ogygia/tsdown-plugin-svelte';

// ─────────────────────────────────────────────────────────────────────────────
// The profiler UI ships as raw `.svelte` files in dist and is compiled by the
// CONSUMER's Svelte pipeline (rendered through document(), hydrated as islands).
// Preprocessing transpiles the SCRIPT but never the template, and the build drops
// `lang="ts"`, so a type left in a `{…}` expression once blew up the consumer's
// `svelte.compile` (`Report.svelte: Expected token }` on `{meta.runs!.length}`,
// and a postcss "Unknown word PROFILER_STYLE" from a `<style>` literal caught in a
// script string). The build now cuts markup types too (scripts/strip-markup-ts.ts),
// so templates may use TS like any Svelte app.
//
// This test reproduces what ships: the build's markup strip, each script TS→JS
// (drop `lang="ts"`), then compile for client AND server. Anything the strip
// misses fails here just like it would in a consumer's CI.
// ─────────────────────────────────────────────────────────────────────────────

// Every dir whose `.svelte` ships raw and gets compiled by the CONSUMER's Svelte pipeline. Add a dir
// here when you ship components from it — the same TS-in-template / <style>-literal traps apply.
const dirs = ['../src/profiler/ui/', '../src/devtools/'];
const files = dirs.flatMap((d) => {
	const abs = fileURLToPath(new URL(d, import.meta.url));
	return readdirSync(abs)
		.filter((f) => f.endsWith('.svelte'))
		.map((f) => abs + f);
});

/** What the build ships: each `<script lang="ts">` body transpiled (what preprocess does, `lang`
 *  kept), then the build's own `strip_markup_ts` cuts the markup's types and drops `lang`. */
function to_consumer_js(source: string, filename: string): string {
	const scripts_js = source.replace(
		/<script\b([^>]*\blang=["']ts["'][^>]*)>([\s\S]*?)<\/script>/g,
		(_m, attrs: string, body: string) => {
			const js = ts.transpileModule(body, {
				compilerOptions: {
					target: ts.ScriptTarget.ESNext,
					module: ts.ModuleKind.ESNext,
					verbatimModuleSyntax: false,
					isolatedModules: true
				}
			}).outputText;
			return `<script${attrs}>\n${js}</script>`;
		}
	);
	return strip_markup_ts(scripts_js, filename);
}

const name_of = (abs: string) => abs.slice(abs.lastIndexOf('/') + 1);

describe('shipped .svelte is consumer-compilable (no TS in template markup)', () => {
	it('found the shipped components', () => {
		expect(files.length).toBeGreaterThan(5);
		expect(files.map(name_of)).toContain('Report.svelte');
		expect(files.map(name_of)).toContain('ProfilerTab.svelte');
	});

	for (const abs of files) {
		const f = name_of(abs);
		it(`${f} compiles after the consumer strips script TS`, () => {
			const js = to_consumer_js(readFileSync(abs, 'utf8'), f);
			// both generate targets — the consumer builds SSR (server) and hydration (client)
			expect(() => compile(js, { filename: f, generate: 'server' })).not.toThrow();
			expect(() => compile(js, { filename: f, generate: 'client' })).not.toThrow();
		});
	}

	// A `<style>…</style>` literal anywhere in a <script> block gets regex-scanned as a real style
	// element by some preprocess pipelines, which then feed its (non-CSS) contents to postcss. Keep the
	// substring out of scripts entirely (Shell.svelte builds the tag from a variable).
	for (const abs of files) {
		const f = name_of(abs);
		it(`${f} has no <style> literal inside a <script> block`, () => {
			const scripts = readFileSync(abs, 'utf8').match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
			for (const block of scripts) {
				expect(block, `${f} script block contains a literal <style> tag`).not.toMatch(/<\/?style>/);
			}
		});
	}
});
