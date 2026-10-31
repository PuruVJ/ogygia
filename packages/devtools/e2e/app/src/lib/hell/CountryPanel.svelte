<script lang="ts">
	// The country selector as a LAKE: frozen server HTML, 240 countries × 3 links, grouped by
	// region with an accordion per region. Ships no JS; the runtime keeps it across navigations.
	// Server side it sorts with an Intl.Collator built per comparison, filters the list once per
	// region per pass (twice), i18n's the counts and tracks each region.
	import type { Country } from './data';
	import { sortCountries } from './util';
	import { t } from './i18n';
	import { track } from './track';
	import Icon from './ds/Icon.svelte';
	let { list: raw }: { list: Country[] } = $props();
	const list = sortCountries(raw);
	const regions = [...new Set(list.map((c) => c.region))];
	for (const r of regions) track('country.region', { region: r, n: list.filter((c) => c.region === r).length });
</script>

<div data-country-panel>
	{#each regions as r (r)}
		<details>
			<summary><Icon name="flag" /> {r} ({list.filter((c) => c.region === r).length})</summary>
			<ul>
				{#each list.filter((c) => c.region === r) as c (c.code)}
					<li>
						<strong>{c.name}</strong> <code>{c.code}</code> <small>{t('country.sites', { n: c.links.length })}</small>
						{#each c.links as l (l.href)}<a href={l.href}>{l.label}</a>{/each}
					</li>
				{/each}
			</ul>
		</details>
	{/each}
</div>
