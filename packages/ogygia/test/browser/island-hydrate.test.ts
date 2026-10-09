// ISLAND HYDRATE, in a real browser (Vitest browser mode, Playwright chromium). The SSR HTML comes
// from `setup.ts` (rendered in Node with `svelte/server`, wrapped in the region shell + props
// sidecar, provided base64 — see the note there); the test boots the real runtime and watches the
// island wake.
import { expect, inject, test } from 'vitest';
import { page } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';

const HYDRATED = 'ogygia-region[data-hydrated]';

/** Decode a `provide()`d HTML string (base64 — a raw `</script>` cannot ride the orchestrator). */
const inject_html = (key: 'counter_ssr_b64' | 'counter_tail_ssr_b64' | 'counter_seedref_ssr_b64') =>
	decodeURIComponent(escape(atob(inject(key))));

// SEED REFERENCES: the props sidecar is a single reference into the page seed; the runtime must
// resolve it against the seed script in the same document and hand the island its own copy.
test('an island whose props are a seed REFERENCE hydrates with the referenced data', async () => {
	document.body.innerHTML = inject_html('counter_seedref_ssr_b64');
	expect(document.querySelector('script[data-ogygia-props]')!.textContent).toContain('OgygiaSeedRef');
	const ssr_button = document.querySelector('button');

	bootDev();

	await expect
		.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	// `start: 3` came from `page.data.counter` through the reference
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	expect(document.querySelector('button')).toBe(ssr_button);
	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
});

// PROPS AFTER THE CONTENT: the page pass keys the sidecar by the region's fingerprint and emits it
// at the end of the body. The runtime must find it by key — the next sibling is page content now.
test('a wake:load island hydrates from a KEYED sidecar at the end of the body', async () => {
	document.body.innerHTML = inject_html('counter_tail_ssr_b64');
	const region = document.querySelector('ogygia-region')!;
	// the sidecar is NOT the next sibling — the filler paragraph is
	expect(region.nextElementSibling?.matches('[data-filler]')).toBe(true);
	const ssr_button = document.querySelector('button');

	bootDev();

	await expect
		.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);
	// props arrived (start: 3), the SSR node was adopted, and the island is live
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	expect(document.querySelector('button')).toBe(ssr_button);
	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
});

test('a wake:load island hydrates in place from its SSR HTML and stays interactive', async () => {
	document.body.innerHTML = inject_html('counter_ssr_b64');
	const ssr_button = document.querySelector('button');
	expect(ssr_button).not.toBeNull();

	bootDev(); // defines <ogygia-region>; the connected region schedules its own hydrate

	await expect
		.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 })
		.toBe(true);

	// The SSR value survived (props sidecar → `start: 3`), and the SSR node was ADOPTED, not re-created.
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	expect(document.querySelector('button')).toBe(ssr_button);

	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
});
