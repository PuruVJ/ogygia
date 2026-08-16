/**
 * The ogygia site — dogfoods `ogygia/content` over the same `docs` collection the rest of the app
 * uses. `folder()` on the collection supplies convention structure as DATA (NN- → order, `+meta.json`
 * → section labels), so `defineSite({ outline: docs })` weaves it with zero extra config. `defineSite()` mints
 * the brains the routes and the sidebar consume. Browser-safe — the nav remote is minted from this in
 * `docs.remote.ts`.
 */
import { links, defineSite } from 'ogygia/content';
import { docs } from './collections.server';

/** The site: the `docs` collection auto-woven by convention (`folder()` supplies order + `+meta.json`
 *  labels as data), "keep reading" from the content graph, and the link audit — a broken in-prose
 *  link fails the BUILD (prerender) and errors in dev on page open. */
export const site = defineSite({ outline: docs, prevNext: 'graph', checks: [links()] });

export { docs };
