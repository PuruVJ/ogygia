<script lang="ts">
	let { title, tagline }: { title: string; tagline?: string } = $props();
</script>

<header class="blk-hero">
	<h1>{title}</h1>
	{#if tagline}<p>{tagline}</p>{/if}
</header>

<style>
	.blk-hero {
		margin: 0 0 1.5rem;
		padding: 2rem 1.5rem;
		border-radius: 12px;
		background: linear-gradient(135deg, var(--ph-accent, #6b8afd) 0%, transparent 220%);
		color: #fff;
	}
	.blk-hero h1 {
		margin: 0 0 0.35rem;
		font-size: 1.9rem;
		letter-spacing: -0.02em;
	}
	.blk-hero p {
		margin: 0;
		opacity: 0.85;
	}
</style>
