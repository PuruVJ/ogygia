import { describe, it, expect } from 'vitest';
import { same_document_link } from '../src/runtime/router.js';

// ─────────────────────────────────────────────────────────────────────────────
// A click on a link to the CURRENT document. Regression: a web-component link (`<x-link>`)
// handles the click itself and re-dispatches one on its inner anchor; the router had already pushed
// the URL for the first click, so the second arrived as "a link to the current page" and was left to
// the browser — which RELOADED the document while the SPA swap was in flight (PES product page → range).
// ─────────────────────────────────────────────────────────────────────────────

const u = (s: string) => new URL(s, 'https://app.test');

describe('same_document_link', () => {
	it('a fragment jump is the browser\'s', () => {
		expect(same_document_link(u('/range/#products'), u('/range/'), null)).toBe('hash');
		expect(same_document_link(u('/range/#products'), u('/range/#overview'), null)).toBe('hash');
	});

	it('a re-dispatched click on the address already in flight is swallowed', () => {
		expect(same_document_link(u('/range/?n=1'), u('/range/?n=1'), 'https://app.test/range/?n=1')).toBe('swallow');
		// even with a hash, when the whole href is the one in flight
		expect(same_document_link(u('/range/?n=1#products'), u('/range/?n=1#products'), 'https://app.test/range/?n=1#products')).toBe('swallow');
	});

	it('a real click on the page one is on refreshes in place, never reloads', () => {
		expect(same_document_link(u('/range/'), u('/range/'), null)).toBe('refresh');
		expect(same_document_link(u('/range/'), u('/range/'), 'https://app.test/other/')).toBe('refresh');
	});
});
