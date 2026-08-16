<script lang="ts">
	import { cms } from '$lib/cms';
	// Home: the nav as plain data, straight off the CMS-backed weave.
	const tree = await cms.nav();
	const first = tree.flatMap((n) => (n.kind === 'group' ? n.items : [])).find((n) => n.kind === 'leaf');
</script>

<h1>cms playground</h1>
<p>
	No markdown files, no <code>NN-</code> folders. Pages, order and section names all come from a fake
	headless CMS over HTTP; the sidebar is the same ogygia weave.
</p>
{#if first && first.kind === 'leaf'}
	<p><a href={first.href}>Start reading → {first.title}</a></p>
{/if}
