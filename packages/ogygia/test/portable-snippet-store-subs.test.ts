// A portable snippet (a `{#snippet}` crossing into a hydrate island) that reads a Svelte STORE
// via the `$store` auto-subscription sugar. The sugar is host-scoped: re-emitted verbatim it
// names an out-of-scope `$`-identifier in the runes-mode synth entry and the build dies inside
// GENERATED code ("`$country` is an illegal variable name" in virtual:ogygia/island/…). The
// transform must instead capture the subscription VALUE at the host (where `$store` is legal),
// rewrite every body occurrence to the capture's prop name, and WARN that the copy is frozen —
// the exact failure a consumer hit in CI (se-web-platform contentPreview page).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	warn.mockRestore();
});
const warned = () => warn.mock.calls.flat().join('\n');

const synth_of = (r: { islands?: Array<{ source?: string }> } | null) =>
	(r?.islands ?? []).map((i) => i.source).find((s) => !!s && s.includes('$props()'));

describe('portable snippet — store auto-subscriptions cross as VALUE snapshots', () => {
	it('captures $store reads (props, template literals, member chains) and rewrites the body', () => {
		// The consumer's shape: island children reading `$country` / `$language` in several capacities.
		const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
	import { country, language } from './stores';
</script>

<Widget>
	{#snippet children()}
		<span data-c={$country}>{\`\${$language}-\${$country.toUpperCase()}\`}</span>
	{/snippet}
</Widget>
`;
		const r = transformHost(HOST, '/app/src/routes/a/+page.svelte', { ...ctx, ssr: true });
		const synth = synth_of(r);
		expect(synth, 'expected a portable-snippet synth').toBeTruthy();
		// No illegal `$`-identifier may survive into the runes-mode entry.
		expect(synth).not.toContain('$country');
		expect(synth).not.toContain('$language');
		// The subscription VALUE rides in as a prop…
		expect(synth).toContain('__og_sub_country');
		expect(synth).toContain('__og_sub_language');
		// …declared exactly once, however many occurrences the body had.
		const decl = synth!.match(/let \{ ([^}]*) \} = \$props\(\)/)?.[1] ?? '';
		expect(decl.split('__og_sub_country').length - 1).toBe(1);
		// Every body occurrence is rewritten — including the member chain inside the template literal.
		expect(synth).toContain('__og_sub_country.toUpperCase()');
		// The HOST evaluates the subscription (legal there) and hands the snapshot across.
		expect(r!.code).toContain('__og_sub_country: $country');
		expect(r!.code).toContain('__og_sub_language: $language');
		// And it says so, loudly, with a trace into the HOST file — not generated code.
		expect(warned()).toContain('FROZEN');
		expect(warned()).toContain('src/routes/a/+page.svelte:8');
	});

	it('hoists an unresolvable $name too, and warns that it could not be verified', () => {
		const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
</script>

<Widget>
	{#snippet children()}
		<em>{$mystery}</em>
	{/snippet}
</Widget>
`;
		const r = transformHost(HOST, '/app/src/routes/b/+page.svelte', { ...ctx, ssr: true });
		// Still hoisted — if Svelte then rejects it, the error lands in the HOST file, not a virtual.
		expect(r!.code).toContain('__og_sub_mystery: $mystery');
		expect(synth_of(r)).not.toContain('$mystery');
		expect(warned()).toContain('cannot verify');
	});

	it('errors loudly when a crossing snippet reads $$props', () => {
		const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
</script>

<Widget>
	{#snippet children()}
		<em>{$$props.title}</em>
	{/snippet}
</Widget>
`;
		expect(() =>
			transformHost(HOST, '/app/src/routes/c/+page.svelte', { ...ctx, ssr: true })
		).toThrow(/\$\$-props cannot cross/);
	});

	it('warns when a host-declared store crosses as an OBJECT (it cannot serialize)', () => {
		const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
	import { writable } from 'svelte/store';
	const counter = writable(0);
</script>

<Widget>
	{#snippet children()}
		<Meter store={counter} />
	{/snippet}
</Widget>
`;
		transformHost(HOST, '/app/src/routes/d/+page.svelte', { ...ctx, ssr: true });
		expect(warned()).toContain('as an OBJECT');
		expect(warned()).toContain('counter');
	});

	it('leaves plain captures untouched next to store captures', () => {
		const HOST = `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
	import { country } from './stores';
	const label = 'hello';
</script>

<Widget>
	{#snippet children()}
		<b title={label}>{$country}</b>
	{/snippet}
</Widget>
`;
		const r = transformHost(HOST, '/app/src/routes/e/+page.svelte', { ...ctx, ssr: true });
		const synth = synth_of(r);
		expect(synth).toContain('label');
		expect(synth).toContain('__og_sub_country');
		expect(r!.code).toContain('label,');
		expect(r!.code).toContain('__og_sub_country: $country');
	});
});
