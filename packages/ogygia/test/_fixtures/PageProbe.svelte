<script>
	// Reads exactly what Kit's server `$app/state` reads: `getContext('__request__').page`.
	import { getContext } from 'svelte';
	const ctx = getContext('__request__');
	const page = ctx?.page;
</script>

<p data-probe>{page ? `${page.status}|${page.url?.pathname ?? '-'}|${page.route.id ?? '-'}|${JSON.stringify(page.data)}` : 'NO CONTEXT'}</p>
