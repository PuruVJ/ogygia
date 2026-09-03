// ISLAND HYDRATE, in a real browser (Vitest browser mode, Playwright chromium). The SSR HTML comes
// from `setup.ts` (rendered in Node with `svelte/server`, wrapped in the region shell + props
// sidecar, provided base64 — see the note there); the test boots the real runtime and watches the
// island wake.
import { expect, inject, test } from 'vitest';
import { page } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';

const HYDRATED = 'ogygia-region[data-hydrated]';

/** Decode a `provide()`d HTML string (base64 — a raw `</script>` cannot ride the orchestrator). */
const inject_html = (key: 'counter_ssr_b64') => decodeURIComponent(escape(atob(inject(key))));

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
