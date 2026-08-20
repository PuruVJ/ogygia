/**
 * `virtual:ogygia/router-config` emitter — the app-wide SPA-router config the server handle reads to
 * inject the runtime + `ogygia-router` meta into every page head. With the router OFF (MPA mode) it
 * instead carries the static Speculation Rules; in SPA mode those are empty on purpose (speculation
 * caches serve real navigations only, which a body-swap router can never read). Pure over the two
 * resolved router flags.
 */
import { mpaSpeculationRules } from './speculation.js';

export function router_config_module(router_enabled: boolean, router_view_transitions: boolean): string {
	return (
		`export const enabled = ${router_enabled};\n` +
		`export const viewTransitions = ${router_view_transitions};\n` +
		`export const speculationRules = ${JSON.stringify(router_enabled ? '' : mpaSpeculationRules())};`
	);
}
