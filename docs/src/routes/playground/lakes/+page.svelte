<script lang="ts">
	// Alternation: shell → island (LakeShell) → lake (FrozenReport) → island-in-lake (InnerBadge).
	// The shell here is dead HTML. LakeShell hydrates and is interactive. FrozenReport is a lake:
	// its code ships in no client chunk, so its own button is inert. Yet the island authored inside
	// the lake (InnerBadge) self-hydrates, because the lake reset its subtree to "dead".
	import LakeShell from '$lib/playground/LakeShell.svelte' with { hydrate: 'load' };
	import FrozenReport from '$lib/playground/FrozenReport.svelte' with { hydrate: 'none' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="Lakes · Playground"
	description="Frozen regions inside hydrated islands — hydrate:none lakes that ship HTML with no client JS, plus islands that wake inside them."
/>

<main class="shell docs-main">
	<section id="lakes">
		<span class="eyebrow">hydrate: 'none'</span>
		<div class="section-header">
			<h2>Lakes</h2>
			<p class="section-lede">
				A lake is hydration switched off again, inside an island. Same declaration, opposite
				polarity. The frozen subtree ships as HTML with none of its JavaScript.
			</p>
		</div>

		<div class="prose" style="margin-bottom: 2rem;">
			<p>
				The card below is one hydrated island. Its counter and toggle work. Nested inside it is a
				lake — the framed panel — whose own button never increments, because its component code is
				in no client chunk. The runtime lifts the lake's SSR DOM out before the parent hydrates and
				restores it after. The accent button <em>inside</em> the lake is a separate island that
				self-hydrates: frozen water can contain live land.
			</p>
			<p>
				Use the toggle to remove and re-add the lake. Default <code>remount</code> is
				<code>'cache'</code> (preset-only overrides: <code>'empty'</code> or
				<code>'swr'</code>), so the frozen DOM is re-inserted from cache.
			</p>
		</div>

		<LakeShell>
			<FrozenReport />
		</LakeShell>
	</section>
</main>
