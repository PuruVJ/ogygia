<script lang="ts">
	// The country selector as a LAKE: frozen server HTML, 240 countries × 3 links, grouped by
	// region with an accordion per region. Ships no JS; the runtime keeps it across navigations.
	import type { Country } from './data';
	let { list }: { list: Country[] } = $props();
	const regions = [...new Set(list.map((c) => c.region))];
</script>

<div data-country-panel>
	{#each regions as r (r)}
		<details>
			<summary>{r} ({list.filter((c) => c.region === r).length})</summary>
			<ul>
				{#each list.filter((c) => c.region === r) as c (c.code)}
					<li>
						<strong>{c.name}</strong> <code>{c.code}</code>
						{#each c.links as l (l.href)}<a href={l.href}>{l.label}</a>{/each}
					</li>
				{/each}
			</ul>
		</details>
	{/each}
</div>
