/**
 * The dash team's federation identity — one `federate()`. dash only ANSWERS (a widget catalog):
 * the shell and the cms both call it, so both are peers (their public keys verify inbound calls
 * and their thaw notices). dash's own private key signs its outbound thaw notices.
 */
import { federate } from 'ogygia/federation';
import { region } from 'ogygia';
// `region: 'raw'`: the fragment root ships as HTML only, but the mark gives its scoped stylesheet
// a real client asset the bake links.
import Kpis from '#lib/Kpis.svelte' with { region: 'raw' };
import * as env from '$app/env/private';

federate({
	name: 'dash',
	key: env.DASH_SIGNING_KEY,
	peers: {
		shell: { origin: env.SHELL_ORIGIN ?? 'http://localhost:5190', key: env.SHELL_PUBLIC_KEY },
		cms: { origin: env.CMS_ORIGIN ?? 'http://localhost:5192', key: env.CMS_PUBLIC_KEY }
	},
	widgets: {
		kpis: {
			props: ['org'], // declared → typed in the manifest stub (`npx ogygia fragments`)
			make: (props, { user, request }) =>
				region(Kpis, {
					org: String(props.org ?? 'acme'),
					viewer: (user as { sub?: string; roles?: string[] } | undefined) ?? null,
					// the trace this hop belongs to (W3C traceparent `00-<trace-id>-<span>-<flags>`):
					// the same id the shell's request started, however many hops away
					trace: request.headers.get('traceparent')?.split('-')[1] ?? null
				})
		}
	}
});
