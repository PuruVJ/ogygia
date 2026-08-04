import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { islands } from 'sk-islands/hooks';

// A trivial second handle to prove `islands()` composes with `sequence()`.
const passthrough: Handle = async ({ event, resolve }) => resolve(event);

// `islands()` serves GET <base>/_islands (server-island rendering); everything else falls
// through to the next handle.
export const handle = sequence(islands(), passthrough);
