<script lang="ts">
	// The `page.data` gotcha, kept on the home page on purpose: standalone this island reads the
	// cms page; mounted in the shell it reads the SHELL's (dev warns). See PageDataProbe.svelte.
	import PageDataProbe from './PageDataProbe.svelte' with { wake: 'load' };
	let { data }: {
		data: {
			posts: { id: string; title: string }[];
			base: string;
			site: string;
		};
	} = $props();
</script>

<h2 data-testid="cms-home">Latest posts</h2>
<PageDataProbe />
<ul>
	{#each data.posts as p (p.id)}
		<li><a href="{data.base}/posts/{p.id}">{p.title}</a></li>
	{/each}
</ul>
