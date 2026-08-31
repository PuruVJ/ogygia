<script lang="ts">
	import LikeButton from './LikeButton.svelte' with { wake: 'load' };
	let { data }: {
		data: {
			post: { id: string; title: string; body: string };
			comments: string[];
			base: string; site: string; section: string; count: number;
			viewer: { sub?: string; roles?: string[] } | null;
		};
	} = $props();
	// role gate: the mounted door carries signed claims; the standalone door carries none
	const is_admin = $derived(data.viewer?.roles?.includes('admin') ?? false);
</script>

<article data-testid="cms-post">
	<h2>{data.post.title}</h2>
	{#if is_admin}<button data-testid="cms-admin-delete">delete post (admin)</button>{/if}
	<p>{data.post.body}</p>
	<LikeButton post={data.post.id} />
	<h3>Comments ({data.comments.length})</h3>
	<ul data-testid="cms-comments">
		{#each data.comments as c, i (i)}<li>{c}</li>{/each}
	</ul>
	<form method="POST" action="{data.base}/posts/{data.post.id}">
		<input name="comment" placeholder="say something" data-testid="cms-comment-input" />
		<button data-testid="cms-comment-submit">post</button>
	</form>
</article>
