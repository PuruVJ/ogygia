<script lang="ts">
	// One POST — the view (baked body region + prev/next) over the `postDoc` remote, rendered by
	// <BlogPost>. The +page.server.ts guard already 404'd unknown slugs.
	import { page } from '$app/state';
	import { BlogPost } from 'ogygia/content';
	import { postDoc } from '$lib/blog.remote';

	const view = (await postDoc(page.params.slug ?? ''))!;
</script>

<BlogPost {view} back="/blog" />
