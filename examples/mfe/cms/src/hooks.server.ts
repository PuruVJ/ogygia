import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as ogygiaHandle } from 'ogygia/server';
import { cms_router } from '$lib/router.js';
// federate() (in peers.server.ts) registers cms's exposed table + peers with the handle, which
// serves /og/fragment/* for the shell's mount() and cms's own thaw notices.
import '$lib/peers.server.js';

// Standalone serving: the SAME router the handle exposes also serves this app's own /cms/*
// directly — one route tree, two front doors.
const mount: Handle = async ({ event, resolve }) => cms_router.handle({ event, resolve });

export const handle = sequence(ogygiaHandle(), mount);
