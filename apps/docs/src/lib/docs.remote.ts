/**
 * The docs navigation as a Kit remote — the pharos site nav (`NavTree`, hrefs baked for the `/docs`
 * mount), devalue-safe metadata, no bodies. The sidebar island and the homepage `ContentPeek` both
 * await this. (Search is CLIENT-side — a worker over the static `/search.json` — so it isn't a
 * remote here; see `SideNav.svelte`.)
 */
import { remotes } from 'ogygia/pharos/server';
import { site } from './docs';

export const { nav } = remotes(site, { base: '/docs' });
