<script lang="ts">
	// Registered but never named by any page tree. Its CSS must NOT be fetched by /blocks —
	// the analysis asserts this (the "registry of 100, page uses 4" economy).
	let { label = 'unused' }: { label?: string } = $props();
</script>

<div class="blk-unused">{label}</div>

<style>
	.blk-unused {
		border: 6px double #7a2a2a;
		padding: 3rem;
	}
</style>
