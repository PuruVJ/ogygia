<script lang="ts">
	// The blog INDEX — post refs over the wire (corpus server-only), rendered by <BlogList>.
	import { BlogList } from 'ogygia/content';
	import { postList } from '$lib/blog.remote';

	const posts = await postList();
</script>

<BlogList {posts} title="ogygia blog" intro="Dogfooding the blog shell — three posts over a dated collection." />
