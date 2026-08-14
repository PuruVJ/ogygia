/**
 * The docs wire layer — pharos remotes over the server-only `site`. `nav` is the sidebar tree
 * (`NavTree`, hrefs baked for `/docs`, no bodies). `doc` resolves one page's view and BAKES its body
 * into a region ticket, so the corpus stays server-side and the page component imports only this —
 * never the collection. The `.svx` demos inside a body wake from the baked ticket exactly as they
 * would in-pass. (Search is client-side — a worker over the static `/search.json`; see `SideNav`.)
 */
import { remotes } from 'ogygia/pharos/server';
import { site } from './docs.server';

export const { nav, doc } = remotes(site, { base: '/docs' });
