// A csr=false document whose load returned promises nobody seeds: Kit streams its resolve scripts
// after the document anyway, and each throws `__sveltekit_… is not defined` (no Kit client here).
// The handle drops exactly those chunks; the document and every other chunk pass untouched.
import { describe, it, expect } from 'vitest';
import { drop_dead_kit_resolves } from '../src/server/dead-kit-resolves.js';

function streamed(chunks: string[]): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(c) {
				for (const s of chunks) c.enqueue(enc.encode(s));
				c.close();
			}
		}),
		{ headers: { 'content-type': 'text/html' } }
	);
}

describe('drop_dead_kit_resolves', () => {
	it('drops Kit resolve chunks, keeps the document and late-region chunks', async () => {
		const doc = '<!doctype html><html><head></head><body><p>hi</p></body></html>';
		const kit = `<script>__sveltekit_dev.resolve(1, (app) => [app.decode('Region', {})])</script>`;
		const kit_nonce = `<script nonce="abc">__sveltekit_1x2y.resolve(2, () => [null])</script>`;
		const late = `<template data-og-late="1"><div>late region</div></template><script>__og_late(1)</script>`;
		const res = drop_dead_kit_resolves(streamed([doc, kit, late, kit_nonce]));
		const text = await res.text();
		expect(text).toBe(doc + late);
		expect(res.headers.get('content-type')).toBe('text/html');
	});

	it('leaves a document that merely mentions the words alone (not a chunk of its own)', async () => {
		const doc = '<!doctype html><body><script>console.log("__sveltekit_ .resolve(")</script></body>';
		expect(await drop_dead_kit_resolves(streamed([doc])).text()).toBe(doc);
	});
});
