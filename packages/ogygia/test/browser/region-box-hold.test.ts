// Box-stability through wake. Svelte's hydrate of a dynamic root detaches the region's subtree for a
// frame before re-attaching it; when the box height lives only inside that subtree (an above-the-fold
// hero whose min-height sits on an inner element, nothing between the region boundary and it holding a
// box), the region collapses to 0 and the page shifts. `hold_region_box` floors the region at its
// measured height for the swap window and releases next frame. This reproduces the reported structure:
// an INLINE <ogygia-region> whose only height comes from a deep inner min-height.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { hold_region_box } from '../../src/runtime/hydrate-core.js';

function next_frame(): Promise<void> {
	return new Promise((r) => requestAnimationFrame(() => r()));
}

let region: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	// The reported shape: inline region → builder wrapper → inner element carrying the min-height.
	region = document.createElement('ogygia-region');
	region.innerHTML =
		'<div data-anchor></div>' + // an empty anchor child (0 height), like the region's first child
		'<div data-builder>' +
		'  <div class="hero" style="min-height:580px;width:100%"></div>' +
		'</div>';
	document.body.appendChild(region);
});

afterEach(() => {
	document.body.innerHTML = '';
});

test('an inline region collapses to 0 when its subtree detaches — without the hold', () => {
	expect(getComputedStyle(region).display).toBe('inline');
	expect(region.getBoundingClientRect().height).toBeGreaterThan(500); // the hero pushes the box
	// Simulate Svelte's mid-hydrate detach of the claimed subtree.
	const kids = [...region.childNodes];
	for (const n of kids) n.remove();
	expect(region.getBoundingClientRect().height).toBe(0); // this is the CLS frame
});

test('with the hold, the region keeps its box while the subtree is detached, then releases', async () => {
	const before = region.getBoundingClientRect().height;
	expect(before).toBeGreaterThan(500);

	hold_region_box(region); // ogygia holds the box just before it hydrates

	// The pin gives the inline region a block box floored at the measured height.
	expect(region.style.display).toBe('block');
	expect(region.style.minHeight).toBe(`${before}px`);

	// Now the subtree detaches mid-hydrate — the box must NOT collapse.
	const kids = [...region.childNodes];
	for (const n of kids) n.remove();
	expect(region.getBoundingClientRect().height).toBeGreaterThan(500);

	// Content comes back (hydrate finished), and the hold releases on the next frame.
	region.innerHTML = '<div style="min-height:580px"></div>';
	await next_frame();
	expect(region.style.minHeight).toBe('');
	expect(region.style.display).toBe('');
});

test('no-op for inline (text) content — never forces an inline region to block', async () => {
	region.innerHTML = 'just some inline text, no box to lose';
	hold_region_box(region);
	expect(region.style.display).toBe('');
	expect(region.style.minHeight).toBe('');
	await next_frame();
});

test('no-op for an empty / zero-height region', async () => {
	region.innerHTML = '<div data-anchor></div>'; // block child but 0 height
	hold_region_box(region);
	expect(region.style.minHeight).toBe('');
	await next_frame();
});

test('a region already block-level is floored but its display is left alone', async () => {
	region.style.display = 'block';
	region.innerHTML = '<div class="hero" style="min-height:400px"></div>';
	hold_region_box(region);
	expect(region.style.minHeight).toBe('400px');
	// display was block already, so nothing to restore there
	await next_frame();
	expect(region.style.minHeight).toBe('');
	expect(region.style.display).toBe('block');
});
