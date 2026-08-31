/**
 * Dash's widget catalog — `catalog()` owns the whole endpoint: signature gate, name lookup,
 * per-request bake (`await region(Comp, props)` renders the component with its islands +
 * prefixed scoped-CSS links), asset absolutizing, trace continuation, and the reserved
 * `__catalog` manifest (`{ names }` — consumers diff it in CI, so a renamed widget becomes a
 * build-time conversation, not a prod 404).
 */
import { env } from '$env/dynamic/private';
import { region } from 'ogygia';
import { catalog } from 'ogygia/router';
// `region: 'raw'`: the fragment root ships as HTML only, but the mark gives its scoped
// stylesheet a real client asset for the bake to prefix as a <link>.
import Kpis from '$lib/Kpis.svelte' with { region: 'raw' };

const keys = [env.SHELL_PUBLIC_KEY, env.CMS_PUBLIC_KEY].filter((k): k is string => !!k);

export const { GET } = catalog(
	{
		kpis: {
			props: ['org'], // declared → typed in the manifest stub (`npx ogygia fragments`)
			make: (props, { user }) =>
				region(Kpis, {
					org: String(props.org ?? 'acme'),
					viewer: (user as { sub?: string; roles?: string[] } | undefined) ?? null
				})
		}
	},
	{ verify: keys.length ? { publicKeys: keys } : false }
);
