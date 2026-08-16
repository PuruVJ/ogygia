/**
 * The wire layer — ogygia remotes over the server-only `site`. The corpus (guide collections + the
 * OpenAPI spec) stays in `docs.server.ts`; every route imports ONLY these remotes, so nothing drags
 * the corpus into the client bundle. `meta` is the whole shell bundle ({ nav, switcher, data }) fed
 * to `<Shell {meta}>`; `doc` resolves one page (baking a markdown body into a region ticket).
 */
import { remotes } from 'ogygia/content/server';
import { site } from './docs.server';

export const { meta, doc, search } = remotes(site, { base: '' });
