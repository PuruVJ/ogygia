/**
 * ONE `client()` per MFE — each remote team's transport policy (Ed25519 signing, timeout,
 * SWR cache, coalescing, invalidation) declared ONCE, then consumed three ways:
 * `mount(cms)` in the route table, `dash.widget()` in the SSR stitch, and `proxy({ dash })`
 * behind the lazy client-stitch holes. No hand-rolled fetch anywhere in the shell.
 */
import { client } from 'ogygia/router';
import { decide } from 'ogygia/flag';

// DEMO ONLY: `?og-exp` overrides are dev-gated by default (any visitor could force themselves
// into unfinished features in prod). This demo opens them unconditionally so the gauntlet can
// exercise override propagation; a real app gates on something unforgeable:
//   decide({ overrides: (c) => c.visitor?.roles?.includes('qa') ?? false })
decide({ overrides: () => true });

const sign = process.env.SHELL_SIGNING_KEY
	? { sign: { privateKey: process.env.SHELL_SIGNING_KEY } }
	: {};

/** The CMS team's whole app — mounted under `/cms/[...rest]`. Bounded latency + SWR cache +
 *  coalescing: the shell is never held hostage by a slow team. */
export const cms = client(process.env.CMS_ORIGIN ?? 'http://localhost:5182', {
	timeout: 800,
	cache: { ttl: 3000 },
	...sign
});

/** The dash team's widget catalog — SSR-stitched and lazily client-stitched. */
export const dash = client(process.env.DASH_ORIGIN ?? 'http://localhost:5181', {
	timeout: 2000,
	...sign
});

/** The shell's session (pretend): a real app reads cookies / its auth layer here. */
export const session = () => ({ sub: 'puru', roles: ['admin'], locale: 'fr' });
