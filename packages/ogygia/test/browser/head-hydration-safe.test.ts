// A csr=false island hydrates in ISOLATION but Svelte's `<svelte:head>` client hydration still scans
// the ONE shared document.head for its `<!--HASH-->` marker and walks the nodes after it. By wake time
// a third party (a design-system/monitoring inject, a hoisted sheet) has usually mutated the head; a
// foreign node in a block's range desyncs that walk into `set_attribute()` on a non-element, which
// throws and discards the whole island. `neutralize_head_hydration_markers` removes the open markers
// so Svelte's head() takes its OWN documented safe path (no marker → re-render the block fresh) instead
// of the fragile walk — while leaving every rendered head ELEMENT (and any comment that is not a paired
// Svelte marker) exactly where it was.
import { beforeEach, expect, test } from 'vitest';
import {
	dedupe_head_titles,
	neutralize_head_hydration_markers
} from '../../src/runtime/hydrate-core.js';

const HASH = 'svelte-1abc23';

/** Build a document.head that mirrors a real csr=false page: Kit's own head, a `<svelte:head>` block
 *  Svelte SSR emitted (`<!--HASH-->` …content… `<!---->`), and — since this is what actually breaks —
 *  a foreign node a third party injected INTO that block's range after SSR. */
function seed_head(): void {
	document.head.innerHTML =
		'<meta charset="utf-8">' +
		`<!--${HASH}-->` +
		'<link rel="preload" href="/hero.avif" as="image">' +
		'<script data-foreign-inject>/* a monitoring / design-system inject landed here */</script>' +
		'<!---->' +
		'<!-- a lone third-party comment, not a svelte marker -->' +
		'<title>Page</title>';
}

const head_comments = () =>
	[...document.head.childNodes].filter((n): n is Comment => n.nodeType === 8);

beforeEach(() => {
	document.head.innerHTML = '';
});

test('the open <svelte:head> marker is removed, so Svelte head() finds no HASH and re-renders instead of crashing', () => {
	seed_head();
	expect(head_comments().some((c) => c.data === HASH)).toBe(true); // precondition
	neutralize_head_hydration_markers();
	// The exact thing svelte-head.js scans for is gone → `head_anchor === null` → safe re-render path.
	expect(head_comments().some((c) => c.data === HASH)).toBe(false);
});

test('every rendered head ELEMENT survives — only inert hydration comments go', () => {
	seed_head();
	neutralize_head_hydration_markers();
	expect(document.head.querySelector('link[rel="preload"][href="/hero.avif"]')).not.toBeNull();
	expect(document.head.querySelector('meta[charset="utf-8"]')).not.toBeNull();
	expect(document.head.querySelector('title')?.textContent).toBe('Page');
	// The foreign inject that would have desynced the walk is left alone (not ours to remove) — but it
	// no longer matters, because the block re-renders instead of walking past it.
	expect(document.head.querySelector('script[data-foreign-inject]')).not.toBeNull();
});

test('a lone head comment (no matching empty close) is never touched', () => {
	seed_head();
	neutralize_head_hydration_markers();
	const lone = head_comments().some((c) => c.data.includes('lone third-party comment'));
	expect(lone).toBe(true);
});

test('a block whose content carries its own Svelte anchors still loses its outer HASH marker', () => {
	// Dynamic `<svelte:head>` content nests block anchors `<!--[-->` … `<!--]-->` inside the block. The
	// depth-aware walk must still identify and drop the OUTER HASH open at top level, or the island crashes.
	document.head.innerHTML =
		`<!--${HASH}-->` +
		'<!--[-->' + // {#if}
		'<meta name="description" content="x">' +
		'<!--]-->' + // closes the {#if}
		'<!---->'; // closes the head block
	neutralize_head_hydration_markers();
	expect(head_comments().some((c) => c.data === HASH)).toBe(false);
	expect(document.head.querySelector('meta[name="description"]')).not.toBeNull();
});

test('a LOOPED + BRANCHED head (each + if/else-if/else, many <link>s) loses its HASH marker', () => {
	// The ResponsiveImage repro: `{#if}` guard, then `{#each responsiveOptions}` with an
	// `{#if index===0}{:else if}{:else}` inside — nested block anchors several deep. The previous
	// stack-pairing mistook `<!--]-->` for an opening comment and left the HASH marker in place, so the
	// island still crashed. Depth tracking pairs the HASH open with the head block's top-level empty close.
	document.head.innerHTML =
		`<!--${HASH}-->` +
		'<!--[-->' + // {#if preloadImages && defaultAspectRatio}
		'<link rel="preload" as="image" href="/hero.avif">' +
		'<!--]-->' +
		'<!--[-->' + // {#if preloadImages && responsiveOptions.length >= 3}
		'<!--[-->' + //   {#each}
		'<!--[-->' + //     {#if index === 0}
		'<link rel="preload" as="image" media="(min-width: 0px)" href="/0.avif">' +
		'<!--]-->' +
		'<!--[!-->' + //    {:else if}
		'<link rel="preload" as="image" media="(min-width: 768px)" href="/1.avif">' +
		'<!--]-->' +
		'<!--[-->' + //     {#if index === 0} (second each item)
		'<link rel="preload" as="image" media="(min-width: 1200px)" href="/2.avif">' +
		'<!--]-->' +
		'<!--]-->' + //   /each
		'<!--]-->' + // /if
		'<!---->'; // head block close
	neutralize_head_hydration_markers();
	expect(head_comments().some((c) => c.data === HASH)).toBe(false);
	// every preload <link> the head rendered survives (only inert hydration comments are touched)
	expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(4);
});

test('an island that re-rendered its own <title> wins: the earlier SSR title is dropped', () => {
	// The page SSR'd a title; a waking island re-rendered its own <title> after it (what the
	// neutralize re-render path produces). The browser honours the FIRST — so the island's must survive.
	document.head.innerHTML =
		'<title>SSR page title</title><meta charset="utf-8"><title>Island title (reactive)</title>';
	dedupe_head_titles();
	const titles = document.head.querySelectorAll('title');
	expect(titles.length).toBe(1);
	expect(titles[0].textContent).toBe('Island title (reactive)');
});

test('a normal single-title page is untouched by the dedupe', () => {
	document.head.innerHTML = '<title>Only title</title><meta charset="utf-8">';
	dedupe_head_titles();
	expect(document.head.querySelectorAll('title').length).toBe(1);
	expect(document.head.querySelector('title')?.textContent).toBe('Only title');
});

test('safe to run on a head with no markers, and idempotent', () => {
	document.head.innerHTML = '<meta charset="utf-8"><title>Plain</title>';
	expect(() => {
		neutralize_head_hydration_markers();
		neutralize_head_hydration_markers();
	}).not.toThrow();
	expect(document.head.querySelector('title')?.textContent).toBe('Plain');
});
