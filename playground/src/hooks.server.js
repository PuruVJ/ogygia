import { sequence } from '@sveltejs/kit/hooks';
import { islands } from 'sk-islands/hooks';

// A trivial second handle to prove `islands()` composes with `sequence()`.
const passthrough = async ({ event, resolve }) => resolve(event);

// `islands()` serves GET <base>/_islands (server-island rendering); everything else falls
// through to the next handle.
export const handle = sequence(islands(), passthrough);
