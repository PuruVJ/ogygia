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

type ServerRenderer = { push: (s: string) => void };
type ServerComponent = (r: ServerRenderer, props: Record<string, unknown>) => void;
type RegionValue = { component?: ServerComponent; props?: Record<string, unknown>; html?: string };

/** A server-side `<Region of={…}/>`: render an inline/dual held region by rendering its component (or
 *  its pre-baked HTML) inline — zero JS, no shell, no signer. Falls back to children for a non-region. */
const Region: ServerComponent = (r, props) => {
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
	return { og_html_region, __register_transportable, __tag_context, __og_$, __og_store, __og_boundary };
}
