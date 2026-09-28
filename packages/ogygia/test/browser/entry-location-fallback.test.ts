// A LOCATION GONE, in a real browser: a page a cache kept names a content-hashed file its build no
// longer serves. The island must still wake — from its identity (the stable name: the current build's
// shim), fetched fresh — not stay dead. The SSR HTML is the Counter island from setup.ts; its identity
// here is the working module, its location a file that 404s.
import { expect, inject, test } from 'vitest';
import { page } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';

const COUNTER = '/test/browser/fixtures/Counter.svelte';
const HYDRATED = 'ogygia-region[data-hydrated]';
const counter_html = () => decodeURIComponent(escape(atob(inject('counter_ssr_b64'))));
const requested = (part: string) => performance.getEntriesByType('resource').filter((r) => r.name.includes(part));

test('the location 404s: the island wakes from its identity, fetched fresh', async () => {
	document.body.innerHTML = counter_html();
	const region = document.querySelector('ogygia-region')!;
	region.setAttribute('entry', COUNTER);
	region.setAttribute('src', '/test/browser/fixtures/chunks/Gone1234.js');
	bootDev();
	await expect.poll(() => document.querySelector(HYDRATED) !== null, { timeout: 10_000 }).toBe(true);
	// (the fixture's props start it at 3: one press, and it is live)
	await expect.element(page.getByTestId('count')).toHaveTextContent('3');
	await page.getByRole('button', { name: 'add' }).click();
	await expect.element(page.getByTestId('count')).toHaveTextContent('4');
	expect(requested('chunks/Gone1234.js')).toHaveLength(1);
	expect(requested('Counter.svelte?og-fresh=')).toHaveLength(1);
});
