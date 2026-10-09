<script lang="ts">
	let { label = 'block b' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-b" data-hb-block="b">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-b {
		--og-hb-token: hbtoken-b;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
