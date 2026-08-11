<script lang="ts">
	let { title = '', body = '' }: { title?: string; body?: string } = $props();
</script>

<div class="blk blk-feature">
	<strong>{title}</strong>
	<p>{body}</p>
</div>

<style>
	.blk-feature {
		border: 1px solid var(--border, #2a2a33);
		border-radius: 10px;
		padding: 0.8rem 0.9rem;
		background: color-mix(in oklab, var(--fg, #fff) 4%, transparent);
	}
	.blk-feature strong {
		display: block;
		margin-bottom: 0.2rem;
	}
	.blk-feature p {
		margin: 0;
		font-size: 0.9rem;
		opacity: 0.75;
	}
</style>
