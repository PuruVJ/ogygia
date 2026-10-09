<script lang="ts">
	// What a region sees of its page (the page-context lab).
	import { page } from '$app/state';
	let { kind }: { kind: string } = $props();
	const data = page.data as { who?: string; locale?: string };
</script>

<p
	data-pc={kind}
	data-who={data.who ?? ''}
	data-locale={data.locale ?? ''}
	data-path={page.url?.pathname ?? ''}
	data-route={page.route?.id ?? ''}
	data-slug={page.params?.slug ?? ''}
>
	{kind}: {data.who ?? 'no page data'} / {data.locale ?? '-'} / {page.url?.pathname}
</p>
