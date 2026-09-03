/**
 * The shell's federation identity — ONE `federate()`, the whole transport config. Each peer is a
 * remote team: its public key verifies the thaw notices it sends the shell; the shell's own private
 * key signs every outbound hop. `visitor` is THE identity, signed on-behalf-of into every hop and
 * derived server-side at deferred-hole time (never via the browser).
 */
import { federate } from 'ogygia/federation';
import { env } from '$env/dynamic/private';

/** The shell's session (pretend): a real app reads cookies / its auth layer here. */
export const session = () => ({ sub: 'puru', roles: ['admin'], locale: 'fr' });

export const { cms, dash } = federate({
	name: 'shell',
	key: env.SHELL_SIGNING_KEY,
	visitor: () => session(),
	peers: {
		// the CMS team's whole app — mounted under /cms/[...rest]; bounded latency + SWR cache
		cms: {
			origin: env.CMS_ORIGIN ?? 'http://localhost:5192',
			key: env.CMS_PUBLIC_KEY,
			timeout: 800,
			cache: { ttl: 3000 }
		},
		// the dash team's widget catalog — stitched into the shell's own pages
		dash: {
			origin: env.DASH_ORIGIN ?? 'http://localhost:5191',
			key: env.DASH_PUBLIC_KEY,
			timeout: 2000
		}
	}
});
