<script lang="ts">
	import { FEATURES } from '$lib/features';
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
</script>

<section class="features" aria-labelledby="features">
	<div class="shell">
		<PermalinkHeading id="features">Features</PermalinkHeading>
		<p class="features-lede">We’ve got them.</p>
		<ul class="features-list">
			{#each FEATURES as feature (feature)}
				<li>{feature}</li>
			{/each}
		</ul>
	</div>
</section>

<style>
	.features {
		padding: clamp(2.5rem, 5vw, 4rem) 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
		background: var(--bg-sunken);
	}

	.features :global(h2) {
		margin: 0;
	}

	.features-lede {
		margin: 0.35rem 0 1.5rem;
		font: italic 500 1.125rem/1.3 var(--font-display);
		color: var(--text-dim);
	}

	.features-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.features-list li {
		padding: 0.55rem 0.9rem;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: var(--bg-raised);
		font: 500 0.8125rem/1.2 var(--font-mono);
		letter-spacing: 0.01em;
		color: var(--text-dim);
	}
</style>
