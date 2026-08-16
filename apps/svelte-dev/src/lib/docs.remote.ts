/**
 * The docs wire layer — everything minted by ogygia `remotes()`:
 *  - `nav(slug?)` — the sidebar tree, prerendered PER dimension coordinate (`nav()` = Svelte,
 *    `nav('kit/')` = SvelteKit, `nav('cli/')` = CLI).
 *  - `doc(slug)` — one page view; its lazy body crosses as a region ticket via the transport hook.
 * (Search is NOT a remote — the static path: prerendered `/docs/search.json` + the on-device Orama
 * worker in the Search UI, with `/docs/search` as the no-JS fallback page.)
 */
import { remotes } from 'ogygia/content/server';
import { site } from './site.server';

export const { nav, doc } = remotes(site, { base: '/docs' });
