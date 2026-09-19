<script lang="ts">
	// The footer as a lake: six columns of thirty links, legal text, no JS.
	let { columns }: { columns: { title: string; links: { label: string; href: string }[] }[] } = $props();
</script>

<footer data-footer-lake>
	{#each columns as c (c.title)}
		<div><h5>{c.title}</h5><ul>{#each c.links as l (l.href)}<li><a href={l.href}>{l.label}</a></li>{/each}</ul></div>
	{/each}
	<p>© 2026 Hell Electric. All rights reserved. Terms · Privacy · Cookies · Accessibility.</p>
</footer>
