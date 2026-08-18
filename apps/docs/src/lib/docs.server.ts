/**
 * The ogygia site — dogfoods `ogygia/content` over the same `guides` collection the rest of the app
 * uses. `folder()` on the collection supplies convention structure as DATA (NN- → order, `+meta.json`
 * → section labels), so `site({ outline: guides })` arranges it with zero extra config. `site()` mints
 * the brains the routes and the sidebar consume. Browser-safe — the nav remote is minted from this in
 * `docs.remote.ts`.
 */
import { links, site } from 'ogygia/content';
import { guides } from './collections.server';

/** The site: the `guides` collection auto-arranged by convention (`folder()` supplies order + `+meta.json`
 *  labels as data), "keep reading" from the content graph, and the link audit — a broken in-prose
 *  link fails the BUILD (prerender) and errors in dev on page open. */
export const docs = site({ outline: guides, prevNext: 'graph', checks: [links()] });

