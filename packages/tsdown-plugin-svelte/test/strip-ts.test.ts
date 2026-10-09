import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { strip_markup_ts } from '../src/index.ts';

describe('strip_markup_ts', () => {
	it('cuts every type-only span from the markup and drops lang="ts"', () => {
		const src = [
			'<script lang="ts">let a = 1;</script>',
			'{#snippet row(l: { a: number }, i: number)}<p>{l.a}</p>{/snippet}',
			'<p>{(a as number).toFixed()} {a!.toString()} {a satisfies number} {foo<string>(a)}</p>',
			'{#each xs as x: number}{x}{/each}',
			'<button onclick={(e: MouseEvent): void => go(e)}>x</button>'
		].join('\n');
		expect(strip_markup_ts(src)).toBe(
			[
				'<script>let a = 1;</script>',
				'{#snippet row(l, i)}<p>{l.a}</p>{/snippet}',
				'<p>{(a).toFixed()} {a.toString()} {a} {foo(a)}</p>',
				'{#each xs as x}{x}{/each}',
				'<button onclick={(e) => go(e)}>x</button>'
			].join('\n')
		);
	});

	it('drops lang from a module script too, and keeps other attributes', () => {
		const src = `<script module lang='ts'>export const k = 1;</script>\n<script lang="ts" generics="T">let { v }: { v: T } = $props();</script>\n<p>{v}</p>`;
		const out = strip_markup_ts(src);
		expect(out).toContain('<script module>');
		expect(out).toContain('<script generics="T">');
		expect(out).not.toContain('lang=');
	});

	it('leaves type-looking text in strings and plain JS components alone', () => {
		expect(strip_markup_ts('<script>let a = 1;</script><p>{a}</p>')).toBe('<script>let a = 1;</script><p>{a}</p>');
		const src = '<script lang="ts">let a = 1;</script><p title="x as Y">{"b as C"} x as y</p>';
		expect(strip_markup_ts(src)).toBe('<script>let a = 1;</script><p title="x as Y">{"b as C"} x as y</p>');
	});

	it('the output compiles as plain JS', () => {
		const src = '<script lang="ts">let items = [1, 2];</script>{#snippet row(n: number)}<li>{n}</li>{/snippet}<ul>{#each items as i}{@render row(i as number)}{/each}</ul>';
		// the script is plain JS already, as it is after preprocess()
		const js = strip_markup_ts(src);
		expect(() => compile(js, { generate: 'server' })).not.toThrow();
		expect(() => compile(js, { generate: 'client' })).not.toThrow();
	});
});
