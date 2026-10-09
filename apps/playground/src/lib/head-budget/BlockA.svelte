<script lang="ts">
	let { label = 'block a' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-a" data-hb-block="a">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	/* `--og-hb-token` survives minification: e2e/head-budget greps every linked sheet for it */
	.hb-a {
		--og-hb-token: hbtoken-a;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
