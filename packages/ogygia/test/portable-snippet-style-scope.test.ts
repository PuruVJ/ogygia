// REGRESSION (field report #3, BUG B): a portable snippet (a `{#snippet}` forwarded into a hydrate
// island) is lifted into its own synth entry. That entry had no `<style>`, so Svelte gave its markup
// NO scope class — and any CSS the host authored for that markup (`.width-100 { … }`, scoped to the
// host's hash) matched nothing. Silently, in prod too: the country-selector panel shipped unstyled
// and content-sized. The fix threads the host's `<style>` into the synth, so the body and the rules
// that style it share one scope hash (the synth's own — it need not equal the host's).
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

const host = (style: string) => `<script>
	import Widget from './Widget.svelte' with { wake: 'load' };
</script>

<span class="probe"></span>
<Widget>
	{#snippet panel()}
		<div class="width-100" data-marker="og-scope-probe"></div>
	{/snippet}
</Widget>
${style}
`;

const WITH_STYLE = host('<style>.probe{color:red}.width-100{width:100%}</style>');
const NO_STYLE = host('');

const synth_of = (source: string) =>
	(transformHost(source, '/app/src/routes/+page.svelte', { ...ctx, ssr: true })?.islands ?? [])
		.map((i: { source?: string }) => i.source)
		.find((s?: string) => !!s && s.includes('og-scope-probe'))!;

const compiled = (synth: string) =>
	compile(synth.replace("import 'virtual:ogygia/transportables';", ''), {
		filename: 'entry.svelte',
		generate: 'server'
	});

describe('portable snippet — the host <style> travels into the synth (scope threading)', () => {
	it('copies the host <style> into the synth entry', () => {
		const synth = synth_of(WITH_STYLE);
		expect(synth).toContain('<style>');
		expect(synth).toContain('.width-100');
	});

	it('scopes the snippet markup to the rule that styles it (one shared hash)', () => {
		const out = compiled(synth_of(WITH_STYLE));
		// The emitted rule carries a scope class …
		const scope = out.css?.code.match(/\.width-100(\.svelte-[a-z0-9]+)/)?.[1];
		expect(scope).toBeTruthy();
		// … and the snippet's markup carries that SAME class, so the rule applies.
		expect(out.js.code).toContain(scope!.slice(1));
		// The rule is not pruned away — it is used by the body it now sits with.
		expect(out.css?.code).not.toContain('(unused) .width-100');
	});

	it('a host with no <style> yields a synth with no <style>, and still compiles', () => {
		const synth = synth_of(NO_STYLE);
		expect(synth).not.toContain('<style');
		expect(() => compiled(synth)).not.toThrow();
	});
});
