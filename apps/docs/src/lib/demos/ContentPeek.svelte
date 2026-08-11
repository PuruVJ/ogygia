<script lang="ts">
	import '$lib/styles/widget.css';
	// The site's OWN docs collection, queried over the wire (bodies stripped). This is an async island
	// — the `<svelte:boundary>` in ogygia's hydrate path keeps it flash-free.
	import { docNav } from '$lib/docs.remote';

	const nav = await docNav();
	const shown = nav.slice(0, 6);
</script>

<div class="content-peek">
	<ul class="cp-list">
		{#each shown as e (e.slug)}
			<li class="cp-item">
				<span class="cp-sec">{e.section}</span>
				<a class="cp-title" href="/docs/{e.slug}">{e.title}</a>
			</li>
		{/each}
	</ul>
	<p class="widget-meta">{nav.length} pages · one <code>content()</code> collection · fetched over the wire</p>
</div>

<style>
	.content-peek {
		display: grid;
		gap: 0.6rem;
	}
	.cp-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.3rem;
	}
	.cp-item {
		display: grid;
		grid-template-columns: 5.5rem 1fr;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.35rem 0.5rem;
		border-radius: 7px;
		border: 1px solid color-mix(in srgb, var(--accent-line, currentColor) 22%, transparent);
	}
	.cp-sec {
		font: 600 0.62rem/1.2 var(--font-mono, monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent, #4ade80);
		opacity: 0.85;
	}
	.cp-title {
		font: 500 0.9rem/1.3 var(--font-body, sans-serif);
		color: var(--text, #e6eee9);
		text-decoration: none;
	}
	.cp-title:hover {
		text-decoration: underline;
	}
	.content-peek code {
		font: 500 0.9em/1 var(--font-mono, monospace);
		color: var(--accent, #4ade80);
	}
</style>
