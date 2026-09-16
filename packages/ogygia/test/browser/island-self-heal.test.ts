// AN ISLAND HYDRATES AGAINST ITS OWN SERVER MARKUP, in a real browser. An island can sleep for a
// long time (`interaction`, `visible`) and other scripts edit the page meanwhile — a design-system
// runtime stripped every whitespace text node of a customer's header while it "hydrated" the
// components around the islands; A/B tools and translators do the same kind of thing. Svelte's
// hydration walk then meets a different node sequence and, left to itself, throws the server DOM
// away and re-renders the island client-side — and the tap that woke the island is replayed onto a
// discarded node (a login dropdown needed two clicks). Now the element keeps the server markup it
// connected with; on a mismatch the runtime puts it back and hydrates THAT.
import { beforeEach, expect, inject, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';

const decode = (key: 'counter_ssr_b64') => decodeURIComponent(escape(atob(inject(key))));

/** The foreign edit: every whitespace-only text node inside the sleeping island removed (what the
 *  customer's design-system `clientHydrate` did), plus a stray comment before the first element
 *  (what an A/B tool leaves behind). Both break Svelte's walk. */
function foreign_edit(region: Element): number {
	let removed = 0;
	const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
	const doomed: Node[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!/\S/.test(n.textContent || '')) doomed.push(n);
	for (const n of doomed) { n.parentNode?.removeChild(n); removed++; }
	region.insertBefore(document.createComment('ab-tool'), region.firstElementChild);
	return removed;
}

beforeEach(() => {
	document.body.innerHTML = '';
});

test('an interaction island edited while asleep hydrates from its server markup on the first click, and the click counts', async () => {
	// the wake:load Counter fixture as an INTERACTION island: it sleeps until the first click
	document.body.innerHTML = decode('counter_ssr_b64').replace('wake="load"', 'wake="interaction"');
	const region = document.querySelector('ogygia-region')!;
	const warns: string[] = [];
	const real_warn = console.warn;
	console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '));
	try {
		bootDev(); // the region connects: keeps its server markup, arms the interaction
		const removed = foreign_edit(region);
		expect(removed, 'the fixture has whitespace text nodes to strip (else the test proves nothing)').toBeGreaterThan(0);
		expect(region.hasAttribute('data-hydrated')).toBe(false);

		await userEvent.click(region.querySelector('button')!);
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(region.hasAttribute('data-og-healed'), 'hydrated from the server markup').toBe(true);
		expect(region.hasAttribute('data-og-recovered'), 'NOT Svelte’s client re-render').toBe(false);
		const stray = [...region.childNodes].some((n) => n.nodeType === 8 && (n as Comment).data === 'ab-tool');
		expect(stray, 'the stray comment is gone with the edit').toBe(false);
		// the waking click was replayed onto the LIVE button: 3 → 4
		await expect.poll(() => region.querySelector('[data-testid="count"]')!.textContent, { timeout: 5_000 }).toBe('4');
		await userEvent.click(region.querySelector('button')!);
		expect(region.querySelector('[data-testid="count"]')!.textContent).toBe('5');
		expect(warns.some((w) => /edited while it slept/.test(w)), 'dev names the heal').toBe(true);
		expect(warns.some((w) => /discarded its ENTIRE/.test(w)), 'no recovery warning').toBe(false);
		expect(warns.some((w) => /^Failed to hydrate/.test(w)), 'Svelte’s own line from the speculative attempt is swallowed').toBe(false);
	} finally {
		console.warn = real_warn;
	}
});

test('an untouched island hydrates in place exactly as before (no heal, the SSR button is adopted)', async () => {
	document.body.innerHTML = decode('counter_ssr_b64');
	const region = document.querySelector('ogygia-region')!;
	const ssr_button = region.querySelector('button')!;
	bootDev();
	await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
	expect(region.hasAttribute('data-og-healed')).toBe(false);
	expect(region.querySelector('button')).toBe(ssr_button);
});
