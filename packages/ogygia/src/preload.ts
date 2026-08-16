// ─────────────────────────────────────────────────────────────────────────────
// preload(region) — the one escape hatch for "fetch now, activate later" (the eager case).
//
// A `render: deferred` / `render: live` region fetches when it WAKES. Sometimes you want the HTML on
// screen fast but the region's own schedule to stay lazy (a below-the-fold hole whose content should
// still paint immediately). `preload(region)` warms that region's address in the frame store now, so a
// bound binder paints as soon as the frame lands — while its `wake` schedule still governs when it
// otherwise fetches. Because the store dedupes by address, the binder JOINS this warm instead of
// firing its own request (see runtime/frame-store `ensure`).
//
// Takes only a region value (from `region()` / a query that returns one). Client-only; a no-op on the
// server and for regions with nothing to fetch (inline/dual, or content already baked into the ticket).
// ─────────────────────────────────────────────────────────────────────────────
import { REGION_BRAND } from './region-brand.js';
import { frameAddress } from './frame.js';
import { ensure } from './runtime/frame-store.js';

export function preload(region: unknown): void {
	if (typeof document === 'undefined') return; // client-only warm (the store is inert on the server)
	const r = region as Record<PropertyKey, unknown> | null;
	if (!r || r[REGION_BRAND] !== true) return; // not a region value — nothing to preload
	const url = typeof r.url === 'string' ? r.url : '';
	if (!url || r.html != null) return; // inline/dual (no url), or the HTML is already baked in — no hole
	const address = frameAddress(url);
	void ensure(address, async (signal) => {
		const res = await fetch(url, { credentials: 'same-origin', signal });
		if (!res.ok) throw new Error('status ' + res.status);
		return res.text();
	}).catch(() => {}); // a failed warm is harmless — the bound region falls back to its own fetch
}
