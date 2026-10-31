<script lang="ts">
	let { label = 'inner' }: { label?: string } = $props();
</script>

<!-- A NESTED island's own scoped sheet (e2e/nested-css): it must reach the page before the outer
     island wakes. `--og-nc-token` survives minification for the CSS grep. -->
<p class="nc-inner" data-nc-inner>{label}</p>

<style>
	.nc-inner {
		--og-nc-token: nctoken-inner;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
