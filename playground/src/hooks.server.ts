import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { ogygiaHandle } from 'ogygia/hooks';

// A trivial second handle to prove `ogygiaHandle()` composes with `sequence()`.
const passthrough: Handle = async ({ event, resolve }) => resolve(event);

// `ogygiaHandle()` serves GET <base>/_islands (server-island rendering); everything else falls
// through to the next handle.
export const handle = sequence(ogygiaHandle(), passthrough);
