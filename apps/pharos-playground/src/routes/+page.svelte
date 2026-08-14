<script lang="ts">
	import { site } from '$lib/docs';
	// Home: prove the nav data is queryable as plain data outside any sidebar chrome.
	const tree = await site.nav();
	const first = tree.flatMap((n) => (n.kind === 'group' ? n.items : [])).find((n) => n.kind === 'leaf');
</script>

<h1>pharos playground</h1>
<p>Three corpora woven into one nav: markdown <code>guides</code>, JSON <code>api</code>, and a link.</p>
{#if first && first.kind === 'leaf'}
	<p><a href={first.href}>Start reading → {first.title}</a></p>
{/if}
