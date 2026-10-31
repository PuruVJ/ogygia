<script lang="ts">
	// The section layout: a breadcrumb strip (i18n'd, tracked) around the page, the design
	// system's CDN runtime (Ionic: Stencil-built web components, the same shape as a corporate
	// design system) and the island that marks its hydration.
	import { t } from '$lib/hell-fixed/i18n';
	import { track } from '$lib/hell-fixed/track';
	import Icon from '$lib/hell-fixed/ds/Icon.svelte';
	import DsHydrateMark from '$lib/hell-fixed/DsHydrateMark.svelte' with { wake: 'load' };
	let { data, children } = $props();
	track('layout.render', { crumbs: data.crumbs.length, toggles: data.toggles.name });
</script>

<svelte:head>
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@ionic/core@8/css/ionic.bundle.css" />
	<script type="module" src="https://cdn.jsdelivr.net/npm/@ionic/core@8/dist/ionic/ionic.esm.js"></script>
</svelte:head>

<DsHydrateMark />
<nav data-crumbs>
	{#each data.crumbs as c, i (c.href)}
		{#if i > 0}<Icon name="chevron" size={12} />{/if}<a href={c.href}>{t(c.label)}</a>
	{/each}
	<small>· session {data.session.name} · toggles {data.toggles.ms} ms</small>
</nav>
{@render children()}
