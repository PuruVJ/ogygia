<script lang="ts">
	let { label = 'block c' }: { label?: string } = $props();
	let n = $state(0);
</script>

<div class="hb-c" data-hb-block="c">
	<strong>{label}</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-c {
		--og-hb-token: hbtoken-c;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
