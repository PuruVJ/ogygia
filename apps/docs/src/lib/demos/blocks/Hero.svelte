<script lang="ts">
	let { title = '', tagline = '' }: { title?: string; tagline?: string } = $props();
</script>

<div class="blk blk-hero">
	<h4>{title}</h4>
	{#if tagline}<p>{tagline}</p>{/if}
</div>

<style>
	.blk-hero {
		background: linear-gradient(135deg, color-mix(in oklab, var(--accent, #6b8afd) 22%, transparent), transparent);
		border: 1px solid color-mix(in oklab, var(--accent, #6b8afd) 30%, transparent);
		border-radius: 12px;
		padding: 1.1rem 1.25rem;
	}
	.blk-hero h4 {
		margin: 0 0 0.25rem;
		font-size: 1.15rem;
	}
	.blk-hero p {
		margin: 0;
		opacity: 0.8;
	}
</style>
