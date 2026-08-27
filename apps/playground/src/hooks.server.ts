import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle, document } from 'ogygia/server';
import { region } from 'ogygia';
import DocTest from '$lib/doctest/DocTest.svelte';

// A trivial second handle to prove `ogygia.handle()` composes with `sequence()`.
const passthrough: Handle = async ({ event, resolve }) => resolve(event);

// Prove `document()`: render a region into a COMPLETE ogygia page from a handle, no +page.svelte.
// The Counter island inside DocTest must hydrate and stay reactive.
const doc_test: Handle = async ({ event, resolve }) => {
	if (event.url.pathname === '/__doctest') {
		return document(region(DocTest, { label: 'hello' }), { status: 200 });
	}
	return resolve(event);
};

// FOREIGN-MUTATION fixture (e2e/detector.ts): on /detector only, corrupt the FIRST island's
// region HTML after SSR — strip Svelte's `<!--[-->` hydration anchors inside it, the way a
// post-SSR HTML middleware (the se.com DSD injector) does. Svelte's hydration must then discard
// that island's server DOM and re-render; the runtime's data-og-recovered detector must flag
// EXACTLY that island and not its healthy sibling. See internal/notes/foreign-dom.md.
const corrupt_detector_region: Handle = async ({ event, resolve }) => {
	if (event.url.pathname !== '/detector') return resolve(event);
	return resolve(event, {
		transformPageChunk: ({ html, done }) => {
			if (!done) return html;
			// first region on the page = Broken.svelte's island
			const start = html.indexOf('<ogygia-region');
			const end = html.indexOf('</ogygia-region>', start);
			if (start === -1 || end === -1) return html;
			const block = html.slice(start, end);
			return html.slice(0, start) + block.replaceAll('<!--[-->', '') + html.slice(end);
		}
	});
};

// The SSR profiler is NOT wired here — it's configured entirely in vite.config.ts (`profiler: true`)
// and ogygia.handle() dynamically imports + mounts it internally. UI at /__profiler (dev = open;
// prod needs ?key=<OGYGIA_PROFILER_SECRET>).
export const handle = sequence(doc_test, ogygiaHandle(), corrupt_detector_region, passthrough);
