/**
 * `virtual:ogygia/router-config` emitter.
 *
 * The handle reads this to inject the runtime + `ogygia-router` meta into every page head (app-wide
 * SPA router). With the router OFF (MPA mode) it instead carries the static Speculation Rules the
 * handle injects: the browser prerenders (Chromium) or prefetches (Firefox) likely next pages
 * natively — nothing to inject where unsupported (Safari), no JS fallback to phase out. In SPA mode
 * the rules are EMPTY on purpose: speculation caches serve real navigations only, which a body-swap
 * router can never read — the router's own prefetch + module warming is the working equivalent there.
 *
 * Pure over the two resolved router flags.
 */
import { mpaSpeculationRules } from './speculation.js';

export function router_config_module(
	router_enabled: boolean,
	router_view_transitions: boolean
): string {
	return (
		`export const enabled = ${router_enabled};\n` +
		`export const viewTransitions = ${router_view_transitions};\n` +
		`export const speculationRules = ${JSON.stringify(router_enabled ? '' : mpaSpeculationRules())};`
	);
}
