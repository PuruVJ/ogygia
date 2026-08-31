/**
 * mount.kit: the SAME cms app mounted from a PLAIN SvelteKit catchall — no ogygia router. The
 * shared client carries all transport policy; identity is read off the event explicitly (a Kit
 * load has no `c.visitor`). One tradeoff vs the router's mount(): an upstream 4xx becomes Kit's
 * error(status) — right status, shell's error page (the router keeps the MFE's error body too).
 */
import { mount } from 'ogygia/router';
import { cms, session } from '$lib/clients.server.js';

const m = mount.kit(cms, { user: () => session() });
export const load = m.load;
export const actions = m.actions;
