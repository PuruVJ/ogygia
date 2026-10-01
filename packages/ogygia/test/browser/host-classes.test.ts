// A web component's own class tokens on its host survive the island's hydrate (Svelte writes
// `class` whole): runtime/host-classes.ts, against the tokens the restorer recorded as Svelte's.
import { afterEach, expect, test } from 'vitest';
import { hydrate } from 'svelte';
import { keep_host_classes, note_host_classes, SVELTE_CLASS } from '../../src/runtime/host-classes.js';
import HostClass from './fixtures/HostClass.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

function region(html: string): HTMLElement {
	const el = document.createElement('ogygia-region');
	el.innerHTML = html;
	document.body.append(el);
	return el;
}

const restored = (el: Element, svelte: string) => ((el as unknown as Record<string, string>)[SVELTE_CLASS] = svelte);

test('the component’s tokens as they are just before the hydrate come back after Svelte’s write', () => {
	const r = region('<x-hero class="relative sc-x-hero-h qds-theme-dark">a</x-hero>');
	const host = r.firstElementChild!;
	restored(host, 'relative');
	const noted = note_host_classes(r);
	host.className = 'relative'; // Svelte's hydrate: class written whole
	keep_host_classes(noted);
	expect(host.className).toBe('relative sc-x-hero-h qds-theme-dark');
});

test('a token the component dropped on the client before the hydrate stays dropped', () => {
	const r = region('<x-hero class="relative qds-theme-dark">a</x-hero>');
	const host = r.firstElementChild!;
	restored(host, 'relative');
	host.classList.remove('qds-theme-dark'); // its mobile script, between restore and hydrate
	const noted = note_host_classes(r);
	host.className = 'relative';
	keep_host_classes(noted);
	expect(host.className).toBe('relative');
});

test('Svelte’s own tokens are never put back; unrestored and replaced elements are left alone', () => {
	const r = region('<x-a class="wide mine">a</x-a><x-b class="theirs">b</x-b><x-c class="c own">c</x-c>');
	const [a, b, c] = Array.from(r.children);
	restored(a, 'wide'); // Svelte's client value drops `wide`: Svelte wins
	restored(c, 'c');
	const noted = note_host_classes(r);
	a.className = '';
	b.className = '';
	c.remove(); // hydration replaced it
	keep_host_classes(noted);
	expect(a.className).toBe('mine');
	expect(b.className).toBe(''); // never restored: not ours to touch
	expect(c.className).toBe('c own');
});

test('through a real Svelte hydrate: the class write happens, and the component’s token survives it', () => {
	// the server HTML Svelte would hydrate (class "relative"), with the component's token already on it
	const r = region('<!--[--><x-hero class="relative qds-theme-dark">a</x-hero><!--]-->');
	const host = r.querySelector('x-hero')!;
	restored(host, 'relative');
	const noted = note_host_classes(r);
	hydrate(HostClass, { target: r, props: { cls: 'relative' } });
	expect(host.isConnected).toBe(true);
	keep_host_classes(noted);
	expect(host.className).toBe('relative qds-theme-dark');
});
