import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';

// A trivial second handle to prove `ogygia.handle()` composes with `sequence()`.
const passthrough: Handle = async ({ event, resolve }) => resolve(event);

// `ogygia.handle()` serves the signed island endpoint (server-island rendering); everything else
// falls through to the next handle.
export const handle = sequence(ogygiaHandle(), passthrough);
