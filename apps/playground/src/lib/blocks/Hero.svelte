<script lang="ts">
	// Static block — no wake mark in the registry, so it ships as HTML only (zero JS).
	let { title, tagline }: { title: string; tagline?: string } = $props();
</script>

<header class="blk-hero">
	<h2>{title}</h2>
	{#if tagline}<p>{tagline}</p>{/if}
</header>

<style>
	/* Distinctive, machine-checkable styles: the analysis asserts on these computed values. */
	.blk-hero {
		background: linear-gradient(135deg, #1e3a5f, #4a1e5f);
		color: white;
		padding: 2rem;
		border-radius: 14px;
	}
	.blk-hero h2 {
		margin: 0 0 0.25rem;
		font-size: 1.6rem;
	}
	.blk-hero p {
		margin: 0;
		opacity: 0.8;
	}
</style>
