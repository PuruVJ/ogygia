<script lang="ts">
	// The site header island: eight mega menus, forty columns, 560 links, a promo per menu, all
	// as ONE config prop (~300 KB, not in page.data — it comes from the header's own module, so it
	// crosses as a full props payload). Dates inside force the devalue lane. On the server it also
	// builds a slug per link and a JSON-LD block per menu, the way a CMS header component does.
	import type { HeaderConfig } from './data';
	import { Slugger, jsonLd } from './util';
	let { config }: { config: HeaderConfig } = $props();
	let open = $state<number | null>(null);
	const slugger = new Slugger();
	const menus = config.menus.map((m) => ({
		...m,
		slug: slugger.slug(m.title),
		columns: m.columns.map((c) => ({ ...c, links: c.links.map((l) => ({ ...l, slug: slugger.slug(l.label) })) })),
		ld: jsonLd({ id: m.slug ?? m.title, name: m.title, price: 0, currency: 'EUR', specs: m.columns })
	}));
</script>

<header data-mega-header>
	<div class="utility">
		{#each config.utility as u (u.href)}<a href={u.href}>{u.label}</a>{/each}
		<span>{config.brand} · {config.locale} · updated {config.updated.toISOString().slice(0, 10)}</span>
	</div>
	<nav>
		{#each menus as m, i (m.title)}
			<button data-slug={m.slug} onclick={() => (open = open === i ? null : i)}>{m.title}</button>
		{/each}
	</nav>
	{#each menus as m, i (m.title)}
		<div class="panel" hidden={open !== i} data-ld={m.ld}>
			{#each m.columns as col (col.title)}
				<div class="col">
					<h4>{col.title}</h4>
					<ul>
						{#each col.links as l (l.href)}
							<li><a href={l.href} data-slug={l.slug}>{l.label}</a>{#if l.badge}<em>{l.badge}</em>{/if}<small>{l.description}</small></li>
						{/each}
					</ul>
				</div>
			{/each}
			<aside><h5>{m.promo.title}</h5><p>{m.promo.body}</p></aside>
		</div>
	{/each}
</header>

<style>
	header { border-bottom: 1px solid #ddd; }
	.panel[hidden] { display: none; }
	.col ul { columns: 2; }
	small { display: block; color: #666; }
</style>
