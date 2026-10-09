<script lang="ts">
	let n = $state(0);
</script>

<div class="hb-direct" data-hb-direct>
	<strong>direct island</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-direct {
		--og-hb-token: hbtoken-direct;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
