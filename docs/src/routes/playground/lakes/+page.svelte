<script lang="ts">
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
	// page → island (LakeShell) → lake (FrozenReport) → island-in-lake (InnerBadge)
	// LakeShell owns both lake imports (cache vs frozenSwr); the page only passes a serializable variant.
	import LakeShell from '$lib/playground/LakeShell.svelte' with { hydrate: 'load' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="Lakes · Playground"
	description="Lakes keep static HTML inside an island — remount cache vs SWR revalidate, plus an island that wakes up again inside a lake."
/>

<main class="shell docs-main">
	<section>
		<span class="eyebrow">hydrate: 'none'</span>
		<div class="section-header">
			<PermalinkHeading id="lakes">Lakes</PermalinkHeading>
			<p class="section-lede">
				A lake keeps a subtree static inside an island. HTML stays. That subtree’s JS never ships.
			</p>
		</div>

		<div class="prose" style="margin-bottom: 2rem;">
			<p>
				Each card below is one island (counter + toggle work). Nested inside is a
				<strong>lake</strong> — the framed panel — whose own button does nothing, because its
				component code is not in any client chunk. The accent button <em>inside</em> the lake is
				another <strong>island</strong>: it becomes interactive again on its own.
			</p>
			<p>
				Toggle removes and re-adds the lake. Watch the <code>SSR at</code> stamp: cache restores
				the same HTML; SWR paints from cache then revalidates through the signed region endpoint
				and gets a fresh stamp. Full remount API:
				<a href="/#remount">docs · Remount</a>.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy">
				<PermalinkHeading id="cache" level={3}><code>remount: 'cache'</code> (default)</PermalinkHeading>
				<div class="prose">
					<p>Toggle restores the cached lake DOM. The SSR stamp should not change.</p>
				</div>
				<LakeShell variant="cache" />
			</div>

			<div class="strategy">
				<PermalinkHeading id="swr" level={3}><code>preset: 'frozenSwr'</code> — remount SWR</PermalinkHeading>
				<div class="prose">
					<p>
						Same lake component, vite preset
						<code>&#123; hydrate: 'none', remount: &#123; revalidate: 'load' &#125; &#125;</code>.
						Toggle paints cached HTML immediately, then re-fetches; the stamp updates after
						revalidate.
					</p>
				</div>
				<LakeShell variant="swr" />
			</div>
		</div>
	</section>
</main>
