<script lang="ts">
	let { tone = 'info', text }: { tone?: 'info' | 'warn'; text: string } = $props();
</script>

<aside class="blk-callout" data-tone={tone}>{text}</aside>

<style>
	.blk-callout {
		margin: 0 0 1rem;
		padding: 0.75rem 1rem;
		border-left: 3px solid var(--og-accent, #6b8afd);
		border-radius: 6px;
		background: color-mix(in oklab, var(--og-accent, #6b8afd) 8%, transparent);
		font-size: 0.95rem;
		line-height: 1.55;
	}
	.blk-callout[data-tone='warn'] {
		border-left-color: #e0a83a;
		background: color-mix(in oklab, #e0a83a 10%, transparent);
	}
</style>
