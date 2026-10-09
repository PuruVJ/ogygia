import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';
import { shell_router } from '$lib/shell-router.js';

// The shell's programmatic router owns /cms/* (the mounted CMS app); everything else
// falls through to the Kit filesystem routes (the home page) — two routers, one app.
const mounted: Handle = async ({ event, resolve }) => shell_router.handle({ event, resolve });

export const handle = sequence(ogygiaHandle(), mounted);
