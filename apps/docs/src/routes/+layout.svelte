<script lang="ts">
	/**
	 * ROOT layout — deliberately empty. This app hosts two sub-apps that must not share styles:
	 *
	 *  - `(docs)` — the ogygia docs site, in the site's own skin (app.css + shell-skin on the ph-*
	 *    hooks). All of its CSS lives in `(docs)/+layout.svelte`, scoped to the group.
	 *  - `playground/` — the ogygia playground, dogfooding the STOCK ogygia shell + the nine
	 *    zen-garden themes. Its chrome and CSS live in `playground/+layout.svelte`.
	 *
	 * Kit collects CSS per layout chain, so keeping this file import-free is what keeps each
	 * sub-app's look sovereign — the "top styles" never leak downward. Cross-app invariants
	 * (csr = false) live in `+layout.ts` beside this.
	 */
	let { children } = $props();
</script>

{@render children()}
