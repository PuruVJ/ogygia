/**
 * The shell's OWN v2 router — the headline API: a whole remote app mounted under shell
 * chrome with ONE table entry, identity + experiments declared ONCE at the table.
 */
import { routes, layout, mount } from 'ogygia/router';
import { cms, session } from './federation.server.js';
import ShellChrome from './ShellChrome.svelte';
import ShellError from './ShellError.svelte';

// error boundary on the chrome layout: a dead mounted app renders the shell's card, not a 500
const chrome = layout('shell', ShellChrome, { error: ShellError });

// The shell's OWN home is a plain KIT route (routes/+page.*) whose load returns REGION values —
// proof that a region crosses a Kit load through the transport hook (src/hooks.ts). The router
// here owns only the mounted cms app.
export const shell_router = routes(
	{
		...chrome({
			// the cms PEER carries the transport policy; mount() is just the page glue
			'/cms/[...rest]': mount(cms)
		})
	},
	{
		base: '',
		// THE identity — resolved once per request, read everywhere as `c.visitor`; every
		// mount signs it into its hops (on-behalf-of, never via the browser).
		visitor: () => session()
		// (No table-wide `flags:` here on purpose: pre-deciding a flag is a flag READ, which would
		// disqualify the anonymous home from FREEZING. A flag a page actually reads still auto-carries
		// into that page's mount hop.)
	}
);
