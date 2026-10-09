// A nested self-hydrating island inside a fetched hole must repair against its TRUE server bytes, not a
// live DOM a swapped-in foreign runtime may already have mutated. When a hole carries declarative shadow
// DOM, `setHTMLUnsafe` attaches shadow roots at parse and a web-component runtime's bootstrap can run its
// upgrade pass over the freshly-connected subtree — reaching a raw custom element inside the nested
// island, attaching a shadow and its normalization dropping neighbouring whitespace text nodes — BEFORE
// ogygia hydrates that island. The island would then snapshot the already-mutated DOM at connect, its own
// drift-check would see a mismatch it did not cause, and it would discard + re-render. region_fragment
// captures each nested island's markup while the fragment is still disconnected (nothing upgrades there),
// so the repair source is pristine. This pins that capture — the hole itself already does the same.
import { expect, test } from 'vitest';
import { region_fragment, pristine_ssr_of } from '../../src/runtime/core.js';

test('a nested self-hydrating island captures its pristine markup (whitespace intact)', () => {
	const { frag } = region_fragment(
		'<div>trigger<ogygia-region entry="/x.js" wake="load"> <span class="a">a</span> <x-icon></x-icon> </ogygia-region></div>'
	);
	const island = frag.querySelector('ogygia-region[entry="/x.js"]')!;
	const pristine = pristine_ssr_of(island);
	expect(pristine).toContain('<span class="a">a</span>');
	expect(pristine).toContain('<x-icon></x-icon>');
	// the whitespace between the elements — exactly what a foreign upgrade drops — is preserved
	expect(pristine).toMatch(/<\/span>\s+<x-icon>/);
});

test('the captured markup is the server bytes, unaffected by a later live mutation of the island', () => {
	const { frag } = region_fragment(
		'<ogygia-region entry="/x.js" wake="load"> <span>a</span> <x-icon></x-icon> </ogygia-region>'
	);
	const island = frag.querySelector('ogygia-region')!;
	const captured = pristine_ssr_of(island);

	// Simulate the foreign upgrade AFTER capture: drop the whitespace text nodes, attach a shadow.
	for (const n of Array.from(island.childNodes)) {
		if (n.nodeType === 3 && !n.textContent?.trim()) n.remove();
	}
	(island.querySelector('x-icon') as HTMLElement).attachShadow({ mode: 'open' });

	// The stash is a snapshot taken before the mutation — so repair still restores the server sequence.
	expect(pristine_ssr_of(island)).toBe(captured);
	expect(pristine_ssr_of(island)).toMatch(/<\/span>\s+<x-icon>/);
	// meanwhile the LIVE island really did lose its whitespace (proving the mutation happened)
	expect([...island.childNodes].some((n) => n.nodeType === 3 && !n.textContent?.trim())).toBe(false);
});

test('a DEFERRED nested region is NOT stamped (it fetches its own answer)', () => {
	const { frag } = region_fragment(
		'<ogygia-region entry="/y.js" render="defer" when="load" endpoint="/__ogygia__?x"></ogygia-region>'
	);
	expect(pristine_ssr_of(frag.querySelector('ogygia-region')!)).toBeUndefined();
});
