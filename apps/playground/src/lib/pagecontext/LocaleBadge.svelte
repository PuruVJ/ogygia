<script lang="ts">
	// An island reading `page.data.locale` on the client (the page-context lab): inside a region a
	// command re-rendered it must hydrate against the locale its HTML was rendered with.
	import { page } from '$app/state';
	let { where }: { where: string } = $props();
	let clicks = $state(0);
</script>

<button data-pc-badge={where} data-locale={(page.data as { locale?: string }).locale ?? ''} onclick={() => clicks++}>
	{(page.data as { locale?: string }).locale ?? '-'} · {clicks}
</button>
