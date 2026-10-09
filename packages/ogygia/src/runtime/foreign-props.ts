/**
 * THE MEMBRANE for foreign islands (fragment federation) — a pure module (no DOM, no virtual
 * imports) so it is unit-testable and safe in any bundle. A FOREIGN-origin island's props parse
 * with wire revivers OFF: reviving a wired ref would construct a class instance from THIS
 * build's codec and hand it to ANOTHER build's svelte — the exact live-value crossing the
 * boundary laws forbid. A ref in a foreign sidecar fails HERE, loudly, at the boundary.
 */
export function foreign_region_prop_revivers(): Record<string, (d: never) => unknown> {
	return {
		OgygiaRef: () => {
			throw new Error(
				'[ogygia] a wired class crossed a build boundary: foreign (stitched-fragment) island ' +
					'props must be plain data — wired live objects cannot reunite across two svelte ' +
					'runtimes. Pass the underlying data instead.'
			);
		}
	};
}
