<script lang="ts">
	// A block island: takes its whole block as ONE prop object (the CMS shape), renders a table.
	import type { Block } from './data';
	let { block }: { block: Block } = $props();
	let n = $state(0);
</script>

<article data-block={block.id}>
	<h3>{block.title}</h3>
	<p>{block.body.slice(0, 80)}…</p>
	<ul>
		{#each block.meta.links as link (link.href)}
			<li><a href={link.href}>{link.label}</a></li>
		{/each}
	</ul>
	<table>
		<tbody>
			{#each block.rows as row (row.sku)}
				<tr><td>{row.sku}</td><td>{row.price.toFixed(2)}</td><td>{row.stock}</td><td>{row.desc}</td></tr>
			{/each}
		</tbody>
	</table>
	<button onclick={() => (n += 1)}>{block.meta.weight} + {n}</button>
</article>
