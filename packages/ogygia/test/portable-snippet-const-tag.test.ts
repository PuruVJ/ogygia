// REGRESSION: a portable snippet (a `{#snippet}` forwarded into a hydrate island) writes its body
// at the synth entry's template root. A body opening with `{@const}` is legal directly under
// `{#snippet}` but not at a template root — Svelte refuses the entry:
//   virtual:ogygia/island/6f13ddda8d9c.svelte:13:4 `{@const}` must be the immediate child of
//   `{#snippet}`, `{#if}`, … (const_tag_invalid_placement)
// A customer page's snippet opened with a feature-flag const and the build died. Such a body keeps
// its snippet around it in the synth, rendered once; a body without one is written as before.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { compile } from 'svelte/compiler';
import { transformHost } from '../src/compiler/region/transform.js';

const ctx = {
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => p,
	visibleMargin: '200px',
	presets: {},
	importKeys: {},
	idSalt: '',
	clientBindingStub: 'virtual:ogygia/client-binding-stub',
	routeCsr: undefined
};

const host = (body: string) => `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
	import { isEnabled } from './flags';
	const flag = 'hp';
</script>

<Widget>
	{#snippet children()}
${body}
	{/snippet}
</Widget>
`;

const WITH_CONST = host(`		{@const enabled = flag && isEnabled(flag)}
		{#if enabled}<p>on</p>{:else}<p>off</p>{/if}`);
const WITHOUT_CONST = host(`		<p>{isEnabled(flag) ? 'on' : 'off'}</p>`);

const synth_of = (source: string) =>
	(transformHost(source, '/app/src/routes/+page.svelte', { ...ctx, ssr: true })?.islands ?? [])
		.map((i: { source?: string }) => i.source)
		.find((s?: string) => !!s && s.includes('./flags'))!;

const compiles = (synth: string) =>
	compile(synth.replace("import 'virtual:ogygia/transportables';", ''), {
		filename: 'entry.svelte',
		generate: 'client'
	}).js.code;

describe('portable snippet — a body opening with {@const}', () => {
	it('keeps its snippet around the body, and the entry compiles', () => {
		const synth = synth_of(WITH_CONST);
		expect(synth, 'expected a portable-snippet synth').toBeTruthy();
		expect(synth).toContain('{#snippet __og_body()}');
		expect(synth).toContain('{@render __og_body()}');
		expect(() => compiles(synth), synth).not.toThrow();
	});

	it('a body without one is written at the template root as before', () => {
		const synth = synth_of(WITHOUT_CONST);
		expect(synth).not.toContain('__og_body');
		expect(() => compiles(synth), synth).not.toThrow();
	});
});
