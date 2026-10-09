<script lang="ts">
	// DECOY: answers at once, asks nothing, throws nothing. No finding may name it.
	let n = $state(0);
</script>

<button data-ds="decoy" onclick={() => n++}>decoy {n}</button>
