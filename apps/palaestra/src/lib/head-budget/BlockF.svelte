<script lang="ts">
	let { label = 'block f' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-f" data-hb-block="f">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-f {
		--og-hb-token: hbtoken-f;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
