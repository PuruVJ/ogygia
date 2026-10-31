<script lang="ts">
	let { label = 'block d' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-d" data-hb-block="d">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-d {
		--og-hb-token: hbtoken-d;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
