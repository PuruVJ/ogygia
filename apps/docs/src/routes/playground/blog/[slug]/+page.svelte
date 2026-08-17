<script lang="ts">
	// One POST — the view (baked body region + prev/next) over the `postPage` remote, rendered by
	// <BlogPost>. The +page.server.ts guard already 404'd unknown slugs.
	import { page } from '$app/state';
	import { BlogPost } from 'ogygia/content';
	import { postPage } from '$lib/playground/blog.remote';

	const view = (await postPage(page.params.slug ?? ''))!;
</script>

<BlogPost {view} back="/blog" />
