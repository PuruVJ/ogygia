/**
 * THE SCENARIO: distributed routes — a package ships a TABLE FRAGMENT the consumer spreads
 * into its own `routes()`. This is a `.ts` in node_modules with a marked import: without the
 * package's `ogygia.files` declaration the compiler would skip this file and the mark would be
 * silently inert (the exact silent death the declaration mechanism exists to prevent).
 */
import { page } from 'ogygia/router';
import PkgPage from './pages/PkgPage.svelte';
// the cms `/lab` pattern: the whole page as ONE island via a marked binding in the table's .ts
import BoardLive from './pages/Board.svelte' with { wake: 'load' };

export const pkg_table = {
	'/pkg': page(PkgPage, { load: () => ({ title: 'from repro-island-pkg' }) }),
	'/pkg/board': page(BoardLive, { load: () => ({ title: 'live board' }) })
};
