/**
 * The shell's OWN v2 router — the headline API: a whole remote app mounted under shell
 * chrome with ONE table entry, identity + experiments declared ONCE at the table.
 */
import { routes, layout, mount } from 'ogygia/router';
import { csr_exp } from '@corp/contracts';
import { cms, session } from './clients.server.js';
import ShellChrome from './ShellChrome.svelte';
import ShellError from './ShellError.svelte';

// error boundary on the chrome layout: a dead mounted app renders the shell's card, not a 500
const chrome = layout('shell', ShellChrome, { error: ShellError });

export const shell_router = routes(
	{
		...chrome({
			// the cms CLIENT carries the transport policy; mount() is just the page glue
			'/cms/[...rest]': mount(cms)
		})
	},
	{
		base: '',
		// THE identity — resolved once per request, read everywhere as `c.visitor`; every
		// mount signs it into its hops (on-behalf-of, never via the browser)
		visitor: () => session(),
		// experiments assign HERE, once — every mount AUTO-CARRIES the buckets in its signed
		// claims, so all teams render this visitor in the same world (a ?og-exp override
		// propagates too, since the shell's ctx sees the query before computing the bucket).
		// No hand-listed claims map: forgetting one entry used to silently fork worlds.
		experiments: [csr_exp]
	}
);
