/**
 * Fill `slots.boot` — the boot helpers and session state the runtime's lazy chunks (the hydrate
 * core, the router's navigation) use. They read them from the registry and never import these
 * modules, so each stays in the runtime chunk alone instead of being split into a shared file
 * (./slots.ts `BootLink` explains why). Core calls this at boot, before any lazy chunk can load; a
 * test that imports a lazy module without booting calls it too. Idempotent.
 */
import { slots } from './slots.js';
import { KitBoot, kit_hydrates_page } from './kit-boot.js';
import { ABSOLUTE_URL_SCHEME, is_warmed_module, warm_island_module } from './region-endpoint-url.js';
import { note_entry_location } from './entry-locations.js';
import { register_island_graph } from './island-graph-preload.js';
import { props_sidecar_of } from './sidecar.js';
import { parse_region_html } from './parse-html.js';
import { runtime_session } from './session.js';
import { regions_in_shadow } from './connected.js';
import { yield_task } from './schedule.js';
import { beacon_nav } from './beacon.js';
import { is_self_owned, walk_enters } from './ownership.js';
import { load_slot } from './load-scheduler.js';

// (the profiler's browser half ships only where something reads it: see `__OGYGIA_BEACON__`; a
// plain import of dist/ without the define keeps it)
const BEACON = typeof __OGYGIA_BEACON__ !== 'undefined' ? __OGYGIA_BEACON__ : true;
const no_beacon_nav: typeof beacon_nav = () => {};

export function link_boot(): void {
	slots.boot ??= {
		kit_hydrates_page,
		KitBoot,
		ABSOLUTE_URL_SCHEME,
		register_island_graph,
		is_warmed_module,
		warm_island_module,
		note_entry_location,
		props_sidecar_of,
		parse_region_html,
		runtime_session,
		regions_in_shadow,
		yield_task,
		beacon_nav: BEACON ? beacon_nav : no_beacon_nav,
		walk_enters,
		is_self_owned,
		load_slot
	};
}
