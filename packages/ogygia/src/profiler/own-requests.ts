import type { ReportMeta, RequestEntry } from './report.js';

/**
 * THE PROFILED PAGE'S OWN REQUESTS among every request the window saw: a page profile's renders
 * (the profiler's own, of that path), a caught or header-profiled request's path. Another visitor's
 * page answered meanwhile carries ITS islands and ITS seed — read from it, a report said the
 * profiled page shipped the other page's data. A window profile has no page: all of them.
 * (Its own module, type imports only: the compare view runs in the browser.)
 */
export function own_requests(meta: ReportMeta): RequestEntry[] {
	if (meta.trigger === 'page' && meta.page) {
		const path = meta.page.split('?')[0];
		return meta.requests.filter((r) => r.internal && r.path === path);
	}
	if (meta.request) return meta.requests.filter((r) => r.path === meta.request!.path);
	return meta.requests;
}
