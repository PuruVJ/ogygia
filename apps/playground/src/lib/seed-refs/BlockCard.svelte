<script lang="ts">
	// A block island: takes its whole block as ONE prop object (the CMS shape).
	import type { Block } from '../../routes/seed-refs/+page.server';
	let { block, mode = 'identity' }: { block: Block; mode?: string } = $props();
	let n = $state(0);
</script>

<article data-block={block.id} data-mode={mode}>
	<h3 data-block-title>{block.title}</h3>
	<p data-block-body>{block.body.slice(0, 60)}…</p>
	<ul>
		{#each block.meta.links as link (link.href)}
			<li><a href={link.href}>{link.label}</a></li>
		{/each}
	</ul>
	<button data-block-btn onclick={() => (n += 1)}>{block.meta.weight} + {n}</button>
</article>
