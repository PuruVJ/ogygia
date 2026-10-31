<script lang="ts">
	import { page } from '$app/state';
	const d = () => page.data as any;
</script>
<span
	class="island"
	data-pd-reader
	data-pd-locale={d()?.locale ?? '(missing)'}
	data-pd-apikey={d()?.countryApiKey ?? '(missing)'}
	data-pd-help={String(d()?.nested?.flags?.helpCenter ?? '(missing)')}
	data-pd-status={page.status}
>locale={d()?.locale ?? '(missing)'}</span>
{#await d()?.fast}
	<span data-pd-fast="pending">fast: pending</span>
{:then v}
	<span data-pd-fast="resolved">fast: {v ?? '(missing)'}</span>
{:catch}
	<span data-pd-fast="error">fast: error</span>
{/await}
{#await d()?.slow}
	<span data-pd-slow="pending">slow: pending</span>
{:then v}
	<span data-pd-slow="resolved">slow: {v ?? '(missing)'}</span>
{:catch}
	<span data-pd-slow="error">slow: error</span>
{/await}
