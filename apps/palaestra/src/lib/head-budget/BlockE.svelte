<script lang="ts">
	let { label = 'block e' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-e" data-hb-block="e">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-e {
		--og-hb-token: hbtoken-e;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
