<script lang="ts">
	let { data }: {
		data: {
			posts: { id: string; title: string }[];
			base: string;
			site: string;
			dash_html: string;
		};
	} = $props();
</script>

<h2 data-testid="cms-home">Latest posts</h2>
<ul>
	{#each data.posts as p (p.id)}
		<li><a href="{data.base}/posts/{p.id}">{p.title}</a></li>
	{/each}
</ul>

<h3>Team dash, inside the CMS, inside the shell:</h3>
<!-- eslint-disable-next-line svelte/no-at-html-tags — trusted federation -->
<div data-testid="nested-dash">{@html data.dash_html}</div>
