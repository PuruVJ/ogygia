/**
 * The CMS team's federation identity. cms both ANSWERS (it exposes its route table) and CALLS
 * (it stitches dash inside its own pages) — so `dash` is a peer it calls, `shell` a peer it hears
 * thaw notices from. Its own private key signs outbound hops + thaw notices.
 *
 * `expose: cms_router` is the whole app served as fragments. The cyclic import with router.ts
 * (which reads the `dash` peer) is fine: router.ts uses `dash` lazily, inside a load.
 */
import { federate } from 'ogygia/federation';
import { cms_router } from './router.js';
import { env } from '$env/dynamic/private';

export const { dash } = federate({
	name: 'cms',
	key: env.CMS_SIGNING_KEY,
	base: '/cms',
	expose: cms_router,
	peers: {
		dash: { origin: env.DASH_ORIGIN ?? 'http://localhost:5191', key: env.DASH_PUBLIC_KEY },
		shell: { origin: env.SHELL_ORIGIN ?? 'http://localhost:5190', key: env.SHELL_PUBLIC_KEY }
	}
});
