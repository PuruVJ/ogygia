<script lang="ts">
	let n = $state(0);
</script>

<div class="hb-unused" data-hb-unused>
	<strong>never placed</strong>
	<button onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.hb-unused {
		--og-hb-token: hbtoken-unused;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
