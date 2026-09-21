<script lang="ts">
	// The footer as a lake: six columns of thirty links, legal text, no JS. i18n'd counts, tracked.
	import { t } from './i18n';
	import { track } from './track';
	let { columns }: { columns: { title: string; links: { label: string; href: string }[] }[] } = $props();
	track('footer.render', { columns: columns.length });
</script>

<footer data-footer-lake>
	{#each columns as c (c.title)}
		<div><h5>{c.title} <small>{t('footer.links', { n: c.links.length })}</small></h5><ul>{#each c.links as l (l.href)}<li><a href={l.href}>{l.label}</a></li>{/each}</ul></div>
	{/each}
	<p>© 2026 Hell Electric. All rights reserved. Terms · Privacy · Cookies · Accessibility.</p>
</footer>
