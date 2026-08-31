/**
 * The shell's OWN v2 router — the headline API: a whole remote app mounted under shell
 * chrome with ONE table entry, identity + experiments declared ONCE at the table.
 */
import { routes, layout, mount } from 'ogygia/router';
import { csr_flag } from '@corp/contracts';
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
		// mount signs it into its hops (on-behalf-of, never via the browser).
		visitor: () => session(),
		// Pre-decide csr_flag HERE: the shell only ROUTES to the cms (it never reads the flag
		// itself), but it wants the visitor's world to travel. Listing it force-decides the bucket
		// so the mount carries it in its signed claims — every team renders the same world. A flag
		// a page actually reads needs no listing (it auto-carries). A ?og-exp override propagates
		// too (the shell's ctx sees the query before deciding).
		flags: [csr_flag]
	}
);
