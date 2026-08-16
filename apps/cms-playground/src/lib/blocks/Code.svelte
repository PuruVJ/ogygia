<script lang="ts">
	let { code, lang = '' }: { code: string; lang?: string } = $props();
</script>

<pre class="blk-code" data-lang={lang}><code>{code}</code></pre>

<style>
	.blk-code {
		margin: 0 0 1rem;
		padding: 1rem;
		border-radius: 8px;
		background: var(--og-bg-code, #16181d);
		color: var(--og-text-code, #d7dae0);
		font-size: 0.85rem;
		line-height: 1.6;
		overflow-x: auto;
	}
</style>
