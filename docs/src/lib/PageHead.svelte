<script lang="ts">
	/** Per-route document head. Title segments join as `A · B · ogygia`. */
	let {
		title = '',
		description = 'ogygia: Astro-style SSR islands for SvelteKit. Hydrate only what needs JavaScript.'
	}: {
		title?: string;
		description?: string;
	} = $props();

	const full_title = $derived(title ? `${title} · ogygia` : 'ogygia — SSR islands for SvelteKit');
	const og_image = 'https://ogygia.puruvj.dev/og.png';
</script>

<svelte:head>
	<title>{full_title}</title>
	<meta name="description" content={description} />
	<meta name="theme-color" content="#0a0f0d" />
	<meta name="color-scheme" content="dark" />

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="ogygia" />
	<meta property="og:title" content={full_title} />
	<meta property="og:description" content={description} />
	<meta property="og:locale" content="en_US" />
	<meta property="og:image" content={og_image} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:alt" content="ogygia — SSR islands for SvelteKit" />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={full_title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={og_image} />
</svelte:head>
