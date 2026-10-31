<script lang="ts">
	// Regression fixture: a PLACED client island (`with { wake: 'load' }`) that carries its own CSS,
	// including a `:global()` rule — the exact shape Rollup can chunk-split OUT of the page's static
	// stylesheet, leaving the island unstyled in a production build. The distinctive outline colour
	// proves the island's own CSS actually loaded on the page.
	let n = $state(0);
</script>

<div data-css-probe>
	<button data-css-probe-btn onclick={() => (n += 1)}>poke {n}</button>
</div>

<style>
	:global([data-css-probe]) {
		outline: 3px solid rgb(9, 176, 84);
	}
	:global([data-css-probe-btn]) {
		border-radius: 999px;
	}
</style>
