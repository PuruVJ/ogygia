<script lang="ts">
	// /dt-fp's decoy: the same props on every render — its fingerprint never moves.
	let { label }: { label: string } = $props();
	let n = $state(0);
</script>

<button data-steady onclick={() => n++}>{label} {n}</button>
