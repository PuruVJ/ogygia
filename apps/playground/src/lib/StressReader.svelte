<script lang="ts">
	import { page } from '$app/state';
	const d = () => page.data as any;
	// Snapshot the many-array promise once so {#await} doesn't re-create it each render.
	const many_all = Promise.all((d()?.many ?? []) as Promise<string>[]);
</script>

{#await d()?.rejects}
	<span data-stress-rejects="pending">r: pending</span>
{:then}
	<span data-stress-rejects="then">r: then (unexpected)</span>
{:catch e}
	<span data-stress-rejects="catch">{e?.message ?? 'err'}</span>
{/await}

{#await d()?.nested then outer}
	<span data-stress-nested-outer>{outer?.label ?? '(none)'}</span>
	{#await outer?.inner}
		<span data-stress-nested-inner="pending">i: pending</span>
	{:then v}
		<span data-stress-nested-inner="resolved">{v ?? '(none)'}</span>
	{:catch}
		<span data-stress-nested-inner="error">i: error</span>
	{/await}
{/await}

{#await many_all}
	<span data-stress-many="pending">many: pending</span>
{:then arr}
	<span data-stress-many="resolved" data-stress-many-count={arr.length} data-stress-many-last={arr[arr.length - 1]}>
		many: {arr.length}
	</span>
{/await}

{#await d()?.falsy then v}
	<span data-stress-falsy>{String(v)}</span>
{/await}

<!-- custom transport type: `.fahrenheit` is a getter — present ONLY if decode rebuilt the class -->
<span data-stress-temp={d()?.temp?.fahrenheit ?? '(not a Temperature)'}>temp</span>
{#await d()?.tempAsync then t}
	<span data-stress-temp-async={t?.fahrenheit ?? '(not a Temperature)'}>tempAsync</span>
{/await}
