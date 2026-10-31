/**
 * `virtual:ogygia/router-config` emitter.
 *
 * The handle reads this to inject the runtime + `ogygia-router` meta into every page head (app-wide
 * SPA router). With the router OFF (MPA mode) the handle injects static Speculation Rules instead
 * (`mpaSpeculationRules`, built by the handle: they leave out its islands endpoint, which the handle
 * knows and the build does not).
 *
 * Pure over the two resolved router flags.
 */
export function router_config_module(
	router_enabled: boolean,
	router_view_transitions: boolean
): string {
	return (
		`export const enabled = ${router_enabled};\n` +
		`export const viewTransitions = ${router_view_transitions};`
	);
}
