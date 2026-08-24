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

// The SSR profiler is NOT wired here — it's configured entirely in vite.config.ts (`profiler: true`)
// and ogygia.handle() dynamically imports + mounts it internally. UI at /__profiler (dev = open;
// prod needs ?key=<OGYGIA_PROFILER_SECRET>).
export const handle = sequence(doc_test, ogygiaHandle(), passthrough);
