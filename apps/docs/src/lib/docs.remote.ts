/**
 * The docs wire layer — ogygia remotes over the server-only `docs` site. `nav` is the sidebar tree
 * (`NavTree`, hrefs baked for `/docs`, no bodies). `doc` resolves one page's view and BAKES its body
 * into a region ticket, so the corpus stays server-side and the page component imports only this —
 * never the collection. The `.svx` demos inside a body wake from the baked ticket exactly as they
 * would in-pass. (Search is client-side — a worker over the static `/search.json`; see `SideNav`.)
 */
import { remotes } from 'ogygia/content/server';
import { docs } from './docs.server';

// `meta` = the leak-free shell bundle (`{ nav, switcher }`) the Shell needs; `doc` = one page view.
export const { nav, meta, page } = remotes(docs, { base: '/docs' });
