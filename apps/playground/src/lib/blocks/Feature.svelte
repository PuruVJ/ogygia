<script lang="ts">
	// Static block — HTML only.
	let { title, body }: { title: string; body?: string } = $props();
</script>

<div class="blk-feature">
	<h3>{title}</h3>
	{#if body}<p>{body}</p>{/if}
</div>

<style>
	.blk-feature {
		border: 2px dashed #7a7a2a;
		border-radius: 8px;
		padding: 1rem;
	}
	.blk-feature h3 {
		margin: 0 0 0.25rem;
	}
	.blk-feature p {
		margin: 0;
		font-size: 0.9rem;
		opacity: 0.75;
	}
</style>
