<script lang="ts">
	// The header island: one big config prop (not in page.data), renders nav + a closed menu.
	import type { HeaderConfig } from './data';
	let { config }: { config: HeaderConfig } = $props();
	let open = $state<number | null>(null);
</script>

<header data-bench-header>
	<nav>
		{#each config.menus as menu, i (menu.title)}
			<button onclick={() => (open = open === i ? null : i)}>{menu.title}</button>
		{/each}
	</nav>
	{#if open !== null}
		<ul>
			{#each config.menus[open].items as item (item.href)}
				<li><a href={item.href}>{item.label}</a> — {item.description}</li>
			{/each}
		</ul>
	{/if}
	<select>
		{#each config.countries as c (c.code)}
			<option value={c.code}>{c.name}</option>
		{/each}
	</select>
</header>
