/**
 * The ogygia module the worker's SSR eval sees for `import … from 'ogygia'` / `'ogygia/internal'`.
 * It REUSES the real library — `region()` / `isRegion` / `og_html_region` — so a held region renders
 * exactly as ogygia renders it, with no stub.
 *
 * A `region: 'raw'` component rendered inline (`region(Badge, props)` + `<Region of={…}/>`) takes the
 * INLINE path (region.ts:219): `region()` with a plain component builds an inline region, the signer is
 * never touched, and no node:crypto / ALS is reached. So held-raw regions are fully renderable in-worker
 * as zero-JS server HTML. The only piece that can't run here is the real `Region.svelte` (it imports
 * `virtual:ogygia/*` the worker can't resolve), so we render its INLINE branch faithfully — the region
 * value and its component are the real ones; only the one-line dispatch (`<Component {...props}/>`,
 * Region.svelte:610) runs here.
 */
// The worker-safe region seam — region()/isRegion/og_html_region WITHOUT Region.svelte or the client
// runtime (which reference `window` and can't load in a Web Worker). See packages/ogygia/src/region-core.ts.
import { region, isRegion, og_html_region } from 'ogygia/internal/region-core';
// The compiler appends `import { … } from 'ogygia/internal/register'` to any module with an exported
// class / createContext / `import.meta.og.$` / `.store` (see compiler/content/transportables.ts +
// macros/browser.ts). That seam is Region-free, so it's safe to pull the REAL registration + macro
// runtime into the worker's SSR eval — user code registers its codec / fn / store exactly as a real
// build would (`__og_$` returns the live fn, `__og_store` the branded store).
import {
	__register_transportable,
	__tag_context,
	__og_$,
	__og_store,
	__og_boundary
} from 'ogygia/internal/register';
import { stringify as devalue_stringify } from 'devalue';

type ServerRenderer = { push: (s: string) => void };
type ServerComponent = (r: ServerRenderer, props: Record<string, unknown>) => void;
type RegionValue = { component?: ServerComponent; props?: Record<string, unknown>; html?: string };

const esc_attr = (s: string) =>
	String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const esc_script = (s: string) => String(s).replace(/<\/(script)/gi, '<\\/$1');
/** The wake schedules a wrapper passes as a boolean prop (`<Region __mode="island" load … />`). */
const WAKE_KEYS = ['load', 'idle', 'visible', 'interaction'] as const;
let region_seq = 0;

/** Render the DRIVER's real island wrapper (`<Region __mode="island|lake|server" …>`) into the `<ogygia-
 *  region>` markup the runtime hydrates — the worker-safe stand-in for `Region.svelte`'s server half
 *  (which can't run here: it imports `$app/*` + `virtual:ogygia/*`). Matches the shape the Harness links
 *  (`entry="__ISLAND__:<id>"`) and the runtime reads (`wake`, `<script data-ogygia-props>`). The island
 *  SSR is rendered INLINE (a nested `svelte/server` render inside the host render isn't re-entrant-safe —
 *  the same reason the hand-built path captures-then-replaces). */
function render_driver_island(r: ServerRenderer, p: Record<string, unknown>, mode: string): void {
	const comp = p.__component as ServerComponent | undefined;
	const inner = (p.__props as Record<string, unknown>) ?? {};
	// The generated wrapper's `__entry` is `/@id/virtual:ogygia/island/<id>.js`; the island id is the
	// Harness's link key (it maps `__ISLAND__:<id>` → a blob URL of the client island module).
	const entry = String(p.__entry ?? '');
	const id = (entry.match(/island\/([0-9a-f]+)\.js/)?.[1] ?? entry).replace(/[^\w]/g, '');
	const wake = mode === 'lake' ? 'none' : (WAKE_KEYS.find((k) => p[k]) ?? 'load');
	// Props that cross by value (children/functions/`$$` never cross), devalue-encoded.
	const crossing: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(inner)) {
		if (k === 'children' || k.startsWith('$$') || typeof v === 'function') continue;
		crossing[k] = v;
	}
	let payload = '[{}]';
	try {
		payload = devalue_stringify(crossing);
	} catch {
		/* leave empty */
	}
	const fp = `obsfp_drv_${id}_${region_seq++}`;
	if (mode === 'server') {
		// A server island: the runtime fetches the HTML from its endpoint. The preview serves the inline
		// SSR as the fallback (a full defer flow needs the fetch intercept — increment 2).
		r.push(
			`<ogygia-region render="defer" when="${esc_attr(wake === 'none' ? 'load' : wake)}" ` +
				`data-og-fp="${fp}" data-obs-real-island data-obs-driver>`
		);
		if (typeof comp === 'function') comp(r, inner);
		r.push(`</ogygia-region>`);
		return;
	}
	r.push(
		`<ogygia-slot><ogygia-region entry="${esc_attr('__ISLAND__:' + id)}" wake="${esc_attr(wake)}" ` +
			`data-og-fp="${fp}" data-obs-real-island data-obs-driver>`
	);
	if (typeof comp === 'function') comp(r, inner);
	r.push(
		`</ogygia-region><script data-ogygia-props>${esc_script(payload)}</script></ogygia-slot>`
	);
}

/** A server-side `<Region …/>`: renders EITHER the driver's real island wrapper (`__mode` set →
 *  `<ogygia-region>` markup, the compiled-app preview) OR a held region (`of={…}` → inline component /
 *  pre-baked HTML, zero JS). Falls back to children otherwise. */
const Region: ServerComponent = (r, props) => {
	const mode = props?.__mode as string | undefined;
	if (mode === 'island' || mode === 'lake' || mode === 'server') {
		render_driver_island(r, props, mode);
		return;
	}
	const of = props?.of as RegionValue | undefined;
	if (of && isRegion(of)) {
		if (typeof of.html === 'string') {
			r.push(of.html); // a pre-baked region body (og_html_region / an awaited region)
			return;
		}
		if (typeof of.component === 'function') {
			of.component(r, of.props ?? {});
			return;
		}
	}
	const kids = props?.children;
	if (typeof kids === 'function') (kids as (r: ServerRenderer) => void)(r);
};

/** The `ogygia` module namespace for the worker SSR eval. Extra named imports fall back to `undefined`
 *  via the caller's proxy (the worker keeps the passthrough for content wrappers). */
export function make_ogygia_server_module(): Record<string, unknown> {
	return { region, isRegion, Region };
}

/** The `ogygia/internal` (and `ogygia/internal/register`) module namespace — the macro-emitted
 *  `og_html_region(…)` resolves real here, as do the appended `__register_transportable` /
 *  `__tag_context` registration calls. */
export function make_ogygia_internal_module(): Record<string, unknown> {
	// `Region` here is the island-capable server shim — the driver's generated wrapper imports
	// `{ Region } from 'ogygia/internal'` and renders `<Region __mode="island" …>`.
	return { Region, og_html_region, __register_transportable, __tag_context, __og_$, __og_store, __og_boundary };
}
