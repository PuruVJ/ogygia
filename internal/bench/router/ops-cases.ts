// Ops/sec microbench cases for the ogygia core's per-island / per-nav hot functions.
// Bundled by ops.ts (rolldown, browser IIFE) and run in real Chromium. Each case is a pure call
// on a real DOM element, so the numbers reflect the actual compiled functions, not a copy.
import {
	is_awake,
	is_deferred,
	region_remount,
	region_schedule,
	region_hydrate_schedule,
	region_is_vacant,
	region_ssr_truncated
} from '../../../packages/ogygia/src/runtime/region-attrs.js';
import { island_module_url } from '../../../packages/ogygia/src/runtime/region-endpoint-url.js';
import { frameAddress } from '../../../packages/ogygia/src/frame.js';
import { parse, stringify } from 'devalue';

// devalue prop payloads as read_region_props sees them (the real per-island parse cost).
const props_empty = stringify({});
const props_small = stringify({ start: 10, label: 'Import-attribute counter' });
const props_complex = stringify({
	date: new Date('2024-01-02T03:04:05.678Z'),
	map: new Map([['a', 1], ['b', 2]]),
	set: new Set([1, 2, 3]),
	nested: { deep: { value: 'nested-ok', when: new Date('2020-05-05T00:00:00.000Z') } },
	items: [{ name: 'Alpha', score: 1 }, { name: 'Bravo', score: 2 }, { name: 'Charlie', score: 3 }]
});

function region(attrs: Record<string, string>): Element {
	const el = document.createElement('ogygia-region');
	for (const k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}

const visible = region({ wake: 'visible', entry: '/_app/immutable/og-region.abc123.js', margin: '200px' });
const deferred = region({ wake: 'load', render: 'defer', when: 'visible', endpoint: '/\u{1F3DD}️?call=greet&v=2' });
const load = region({ wake: 'load', entry: './_app/immutable/nested/x.js' });

// A region with SSR children, so region_is_vacant / region_ssr_truncated do real subtree work.
const populated = region({ wake: 'load', entry: '/_app/immutable/y.js' });
populated.innerHTML = '<!--[--><div class="island"><button>clicks: <span>0</span></button></div><!--]-->';

export const cases: Record<string, () => unknown> = {
	region_schedule: () => region_schedule(visible),
	is_deferred: () => is_deferred(deferred),
	is_awake: () => is_awake(visible),
	region_remount: () => region_remount(visible),
	region_hydrate_schedule: () => region_hydrate_schedule(visible),
	region_is_vacant: () => region_is_vacant(populated),
	region_ssr_truncated: () => region_ssr_truncated(populated),
	island_module_url_abs: () => island_module_url('/_app/immutable/og-region.abc123.js'),
	island_module_url_rel: () => island_module_url('./_app/immutable/nested/x.js', 'http://localhost/docs/guide/'),
	frameAddress: () => frameAddress('/\u{1F3DD}️?call=greet&v=2'),
	devalue_parse_empty: () => parse(props_empty),
	devalue_parse_small: () => parse(props_small),
	devalue_parse_complex: () => parse(props_complex)
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__opscases = cases;
