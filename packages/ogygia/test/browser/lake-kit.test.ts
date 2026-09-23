// A LAKE on a KIT-HYDRATED (csr=true) document, in a real browser. Kit hydrates the whole document
// there — `hydrate()` over the SSR DOM, exactly what this test does — while the lake's component is
// a render-nothing placeholder on the client. The wrapper's client leg must ADOPT the server element
// verbatim (no mismatch, the frozen HTML and its node identities survive), and the island authored
// inside the lake must wake on the ogygia runtime, since Kit never hydrates a lake's inside. The
// bug this pins: the lake rendered as a normal template → hydration_mismatch → Kit re-rendered the
// page client-side and the whole lake vanished (a site header on a csr=true page).
import { afterEach, beforeEach, expect, inject, test } from 'vitest';
import { page } from 'vitest/browser';
import { hydrate, unmount } from 'svelte';
import { bootDev } from '../../src/runtime/full.js';
import LakeKitHost from './fixtures/LakeKitHost.svelte';
import { publish_kit_page, unpublish_kit_page } from './_kit-thread.js';

// Kit's client entry publishes its page thread BEFORE Kit hydrates; an island of ours on a Kit
// document waits for that thread (kit-page-thread.ts), so a faithful Kit document carries it.
beforeEach(() => publish_kit_page());
afterEach(() => unpublish_kit_page());

const LAKE = 'ogygia-region[wake="none"]';
const ISLAND_HYDRATED = 'ogygia-region[wake="load"][data-hydrated]';

/** Decode a `provide()`d HTML string (base64 — a raw `</script>` cannot ride the orchestrator). */
const inject_html = (key: 'lake_kit_ssr_b64') => decodeURIComponent(escape(atob(inject(key))));

test('Kit hydration adopts the lake verbatim; the island inside wakes on the runtime', async () => {
	const warns: string[] = [];
	const real_warn = console.warn;
	console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
	try {
		// Kit's bootstrap (the inline `__sveltekit_… =` assignment) is what marks a document as
		// Kit-hydrated on the client, for Region's `is_csr` and the runtime's guards alike.
		document.body.innerHTML =
			'<script>__sveltekit_lab = {};</script>' +
			'<div data-mount>' +
			inject_html('lake_kit_ssr_b64') +
			'</div>';
		const mount = document.querySelector('[data-mount]') as HTMLElement;
		const lake = document.querySelector(LAKE);
		const frozen = document.querySelector('[data-frozen]');
		const count = document.querySelector('[data-testid="count"]');
		expect(lake).not.toBeNull();
		expect(frozen).not.toBeNull();
		expect(count).not.toBeNull();

		// Kit's hydration pass over the SSR DOM.
		const app = hydrate(LakeKitHost, { target: mount });

		// The lake's server DOM was ADOPTED: same nodes, nothing re-created, no mismatch.
		expect(document.querySelector(LAKE)).toBe(lake);
		expect(document.querySelector('[data-frozen]')).toBe(frozen);
		expect(document.querySelector('[data-testid="count"]')).toBe(count);
		expect(warns.filter((w) => w.includes('hydration_mismatch'))).toEqual([]);
		// The shell around it hydrated normally.
		expect(document.querySelector('[data-shell-text]')?.textContent).toBe('shell');

		// The island INSIDE the lake is ours: the runtime wakes it (Kit never hydrated it).
		bootDev();
		await expect
			.poll(() => document.querySelector(ISLAND_HYDRATED) !== null, { timeout: 10_000 })
			.toBe(true);
		expect(document.querySelector('[data-kit-hydrated]')).toBeNull();
		await expect.element(page.getByTestId('count')).toHaveTextContent('3');
		await page.getByRole('button', { name: 'add' }).click();
		await expect.element(page.getByTestId('count')).toHaveTextContent('4');

		unmount(app);
	} finally {
		console.warn = real_warn;
	}
});

// A KIT HYDRATION FAILURE (a component threw during hydration, or the markup mismatched): Svelte
// discards the server DOM and mounts fresh — and the lake wrapper's client form renders the lake
// element EMPTY (a lake is server HTML; the client has none). REGRESSION (customer deploy,
// 2026-09-15): a site header authored as a lake vanished on every client-on page where an app
// component threw inside Kit's hydration. The runtime must bring the lake back: it remembered the
// SSR children when the lake first connected, so the fresh vacant element repaints from that copy,
// and the island authored inside reconnects and wakes again.
test('a lake re-created empty after a Kit hydration failure is repainted from its server HTML; its island wakes again', async () => {
	document.body.innerHTML =
		'<script>__sveltekit_lab = {};</script>' +
		'<div data-mount>' +
		inject_html('lake_kit_ssr_b64') +
		'</div>';
	const mount = document.querySelector('[data-mount]') as HTMLElement;
	const lake_id = document.querySelector(LAKE)!.getAttribute('entry')!;
	const app = hydrate(LakeKitHost, { target: mount });
	bootDev();
	await expect
		.poll(() => document.querySelector(ISLAND_HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	// what Svelte's fallback does: the old tree goes, a fresh client render lands — the lake empty
	unmount(app);
	mount.innerHTML = `<ogygia-region entry="${lake_id}" wake="none" remount="cache"></ogygia-region>`;
	const fresh = document.querySelector(LAKE) as HTMLElement;
	// the repaint is synchronous at connect (the copy is already in the session cache)
	await expect
		.poll(() => fresh.querySelector('[data-frozen]') !== null, { timeout: 10_000 })
		.toBe(true);
	await expect
		.poll(() => fresh.querySelector(ISLAND_HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
});
