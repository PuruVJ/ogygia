// REGRESSION: a portable snippet (a `{#snippet}` forwarded into a hydrate island) hoists the host
// imports its body captures into the synth wrapper. When SEVERAL captured names come from ONE import
// statement (`import { a, b, c } from './x'`), the wrapper must emit that statement ONCE — not once
// per name, which redeclares the identifiers and fails the build:
//   RollupError: Identifier 'handleClickUrl' has already been declared
import { describe, it, expect } from 'vitest';
import path from 'node:path';
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

// A snippet forwarded into a hydrate island, whose body captures THREE names from one import.
const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
	import { handleClickUrl, getLocalValue, isInternalLink } from './helpers';
</script>

<Widget>
	{#snippet children()}
		<a onclick={handleClickUrl} href={getLocalValue()}>{isInternalLink() ? 'in' : 'out'}</a>
	{/snippet}
</Widget>
`;

describe('portable snippet — captured imports from one statement', () => {
	it('hoists the shared import ONCE, not once per captured name', () => {
		const r = transformHost(HOST, '/app/src/routes/+page.svelte', { ...ctx, ssr: true });
		const synth = (r?.islands ?? [])
			.map((i: { source?: string }) => i.source)
			.find((s?: string) => !!s && s.includes('./helpers'));
		expect(synth, 'expected a portable-snippet synth that captures ./helpers').toBeTruthy();
		const count = (synth!.match(/from '\.\/helpers'/g) || []).length;
		expect(count, `the ./helpers import must appear once; got ${count}\n---\n${synth}\n---`).toBe(
			1
		);
	});
});
