// THE CROSS-ORIGIN-ISOLATED LAB: the page answers with Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy (what a page that needs SharedArrayBuffer sends). Safari then gives
// the document's request and first byte as 0 — the beacon dropped the whole visit over it. The
// visit must reach the report, its first byte said hidden, never 0 ms.
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
	return { at: 'cross-origin-isolated lab' };
};
