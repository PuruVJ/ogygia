import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';
import { profiler } from 'ogygia/profiler';

// A trivial second handle to prove `ogygia.handle()` composes with `sequence()`.
const passthrough: Handle = async ({ event, resolve }) => resolve(event);

// The SSR profiler goes FIRST so it times the whole chain below it. UI at /__profiler
// (dev = open; prod needs ?key=<PROFILER_SECRET>). `ogygia.handle()` serves the signed
// island endpoint; everything else falls through to the passthrough.
export const handle = sequence(profiler(), ogygiaHandle(), passthrough);
