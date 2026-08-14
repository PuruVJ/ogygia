import { site } from '$lib/docs';

// The pharos site's `load` is a thin 404 guard: `error(404)` thrown from a load maps to a real,
// styled 404 (thrown from the component's top-level await it would escalate to a 500 in dev). The
// page's actual data comes from `site.doc()` in the component (csr=false island-body semantics).
export const load = site.load;
