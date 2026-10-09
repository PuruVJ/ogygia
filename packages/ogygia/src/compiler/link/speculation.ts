/**
 * MPA-mode Speculation Rules — the static `prerender` / `prefetch` JSON the server handle injects
 * into every page head when the SPA router is OFF (`router: false`). Pure: no build state, one
 * deterministic string. Covered by unit tests.
 */

/**
 * Static Speculation Rules for MPA mode (`router: false`) — the server handle injects them into
 * every page head. Document rules covering same-origin links, with a per-link/subtree opt-out
 * (`data-ogygia-speculate="off"`, re-enable with `"on"`); the region endpoint is never speculated.
 * BOTH lists ship: a prerender-capable browser prerenders (prefetch is its first stage), a
 * prefetch-only browser prefetches, an unsupporting one ignores the JSON entirely — graceful by
 * construction, no JS fallback. In SPA mode no rules exist at all: speculation caches serve real
 * navigations only, which a body-swap router can never read.
 *
 * @internal Exported for unit tests.
 */
export function mpaSpeculationRules(): string {
	const where = {
		and: [
			{ href_matches: '/*' },
			{ not: { href_matches: '/__ogygia__*' } },
			{ not: { selector_matches: '[rel~=nofollow]' } },
			{
				or: [
					{
						not: {
							selector_matches: '[data-ogygia-speculate="off"], [data-ogygia-speculate="off"] *'
						}
					},
					{ selector_matches: '[data-ogygia-speculate="on"], [data-ogygia-speculate="on"] *' }
				]
			}
		]
	};
	return JSON.stringify({
		prerender: [{ where, eagerness: 'moderate' }],
		prefetch: [{ where, eagerness: 'moderate' }]
	});
}
