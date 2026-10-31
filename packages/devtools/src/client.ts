/**
 * The BROWSER half of `devtools()` (its `client`): the dock's launcher, and
 * the leftovers watch (what a region's component leaves running after it leaves the page). With the dock off
 * (`devtools({ dock: false })`, core's events not compiled in) every hook here folds to nothing.
 */
import { defineClient, type ClientPlugin } from '@ogygia/core/plugin/client';
import { install_devtools_ui } from './devtools/ui.ts';
import {
	watch_leftovers,
	leftover_island_seen,
	leftover_island_gone
} from './devtools/leftovers.ts';

const DOCK = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

const client: ClientPlugin = defineClient({
	boot({ kitPage }) {
		if (!DOCK) return;
		// one mounted Svelte app (launcher + tabbed window), starting hidden (Alt+O); a pure bus/DOM consumer
		install_devtools_ui(kitPage ? { csr_true: true } : undefined);
		// watched from before the first island wakes (a Kit page has no ogygia islands)
		if (!kitPage) watch_leftovers();
	},
	regionMount(el, { entry, urls }) {
		if (DOCK) leftover_island_seen(el, entry, [...urls]);
	},
	regionUnmount(el, { entry }) {
		if (DOCK) leftover_island_gone(el, entry);
	}
});

export default client;
