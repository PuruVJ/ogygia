import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle, document } from 'ogygia/server';
import { region } from 'ogygia';
import { profiler } from 'ogygia/profiler';
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

// The SSR profiler goes FIRST so it times the whole chain below it. UI at /__profiler
// (dev = open; prod needs ?key=<PROFILER_SECRET>). `ogygia.handle()` serves the signed
// island endpoint; everything else falls through to the passthrough.
export const handle = sequence(profiler(), doc_test, ogygiaHandle(), passthrough);
