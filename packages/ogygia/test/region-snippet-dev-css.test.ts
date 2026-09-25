// REGRESSION (field report #4): a `{#snippet}` forwarded into an island crosses as its PORTABLE form,
// whose entry carries the host's `<style>`. On a csr=false page the entry renders frozen and its module
// is never imported on the client, so its scoped CSS silently never applied in dev (prod ships it via
// fouc-css — a dev ≠ prod gap). The portable form's SSR threads a region-css link for its entry url
// into <head>, so the boot rescue imports it and the scoped <style> injects. (Rendered IN PLACE — not
// crossing — the snippet is the host's own and wears the host's scope: nothing to thread.)
import { it, expect } from 'vitest';
import { og_portable } from '../src/region-snippet.js';
import { PORTABLE_FORM } from '../src/portable-form.js';

// A hand-written server component (svelte/server calls `(payload, props) => void`); no-op body.
const Entry = ((_$$renderer: unknown, _$$props: unknown) => {}) as never;
const native = (() => {}) as never;

type HeadChild = { push: (h: string) => void };
type MockRenderer = {
	push: (h: string) => void;
	global: { mode: string };
	head: (fn: (c: HeadChild) => void) => void;
};

it('DEV: a live region snippet’s portable form threads its entry region-css link into <head>', () => {
	const url = '/@id/virtual:ogygia/island/deadbeefcafe.svelte';
	const branded = og_portable(native, Entry, {}, url) as unknown as Record<string, unknown>;
	const snippet = branded[PORTABLE_FORM] as (r: MockRenderer) => void;

	const head: string[] = [];
	const renderer: MockRenderer = {
		push: () => {},
		global: { mode: 'sync' }, // force the synchronous render path
		head: (fn) => fn({ push: (h) => head.push(h) })
	};

	snippet(renderer);

	const emitted = head.join('');
	expect(emitted).toContain('data-ogygia-region-css');
	expect(emitted).toContain(url);
	expect(emitted).toContain('rel="stylesheet"');
});
