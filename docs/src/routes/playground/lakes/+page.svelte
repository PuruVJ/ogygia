<script lang="ts">
	// page → island (LakeShell) → lake (FrozenReport) → island-in-lake (InnerBadge)
	import LakeShell from '$lib/playground/LakeShell.svelte' with { hydrate: 'load' };
	import FrozenReport from '$lib/playground/FrozenReport.svelte' with { hydrate: 'none' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="Lakes · Playground"
	description="A lake keeps static HTML inside an island — no client JS — and an island inside that lake can become interactive again."
/>

<main class="shell docs-main">
	<section id="lakes">
		<span class="eyebrow">hydrate: 'none'</span>
		<div class="section-header">
			<h2>Lakes</h2>
			<p class="section-lede">
				A lake keeps a subtree static inside an island. HTML stays. That subtree’s JS never ships.
			</p>
		</div>

		<div class="prose" style="margin-bottom: 2rem;">
			<p>
				The card below is one island (counter + toggle work). Nested inside it is a
				<strong>lake</strong> — the framed panel — whose own button does nothing, because its
				component code is not in any client chunk. The accent button <em>inside</em> the lake is
				another <strong>island</strong>: it becomes interactive again on its own.
			</p>
			<p>
				Toggle removes and re-adds the lake. Default <code>remount</code> is
				<code>'cache'</code> (preset overrides: <code>'empty'</code>, <code>'swr'</code>), so the
				static DOM comes back from cache.
			</p>
		</div>

		<LakeShell>
			<FrozenReport />
		</LakeShell>
	</section>
</main>
