<script lang="ts">
	import '$lib/styles/widget.css';
	// The site's OWN pharos nav, queried over the wire (bodies stripped). Section labels + hrefs are
	// pharos-derived (the same `NavTree` the sidebar renders), so the homepage is on pharos too.
	//
	// This island is rendered through a SYNCHRONOUS `{@render demo()}` (it's a `demo` snippet handed to
	// ShowcaseCard), which drops out of async render mode — so a top-level `await nav()` here throws
	// `await_invalid` and NO island-level boundary can restore async from below that point. `{#await}`
	// is its own async block that Svelte handles in sync render mode, so it works AND keeps this
	// widget's loading state LOCAL (a boundary with `pending` up the tree stays the author's choice).
	import { nav } from '$lib/docs.remote';

	// TOP-LEVEL AWAIT, deliberately: this island lives inside a `demo` snippet handed to ShowcaseCard,
	// so it renders through the portable-snippet path — whose server leg now threads the outer async
	// renderer (region-snippet.ts). This line is the regression canary for that machinery.
	const tree: any = await nav();
	const leaves = tree.flatMap((n: any) =>
		n.kind === 'group'
			? n.items.filter((i: any) => i.kind === 'leaf').map((l: any) => ({ section: n.label, title: l.title, href: l.href }))
			: []
	);
	const shown = leaves.slice(0, 6);
	const count = leaves.length;
</script>

<div class="content-peek">
	<ul class="cp-list">
		{#each shown as e (e.href)}
			<li class="cp-item">
				<span class="cp-sec">{e.section}</span>
				<a class="cp-title" href={e.href}>{e.title}</a>
			</li>
		{/each}
	</ul>
	<p class="widget-meta">{count} pages · one <code>content()</code> collection · fetched over the wire</p>
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
