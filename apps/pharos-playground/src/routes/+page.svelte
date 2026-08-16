<script lang="ts">
	import { meta } from '$lib/docs.remote';
	// Home: prove the nav data is queryable as plain data (over the wire, corpus server-only).
	const tree = (await meta('')).nav;
	const first = tree.flatMap((n) => (n.kind === 'group' ? n.items : [])).find((n) => n.kind === 'leaf');
</script>

<h1>ogygia playground</h1>
<p>Three corpora woven into one nav: markdown <code>guides</code>, JSON <code>api</code>, and a link.</p>
{#if first && first.kind === 'leaf'}
	<p><a href={first.href}>Start reading → {first.title}</a></p>
{/if}
