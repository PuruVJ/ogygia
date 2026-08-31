import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';
import { cms_router } from '$lib/router.js';

// Standalone serving: the SAME router the fragment endpoint exposes also serves this app's
// own /cms/* directly — one route tree, two front doors (the "one component, two lives" rule).
const mount: Handle = async ({ event, resolve }) => cms_router.handle({ event, resolve });

export const handle = sequence(ogygiaHandle(), mount);
