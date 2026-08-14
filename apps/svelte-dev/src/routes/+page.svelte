<script lang="ts">
	import Hero from './_home/Hero.svelte';
	import { TOPICS } from '$lib/topics';
</script>

<svelte:head>
	<title>Svelte • Web development for the rest of us</title>
	<meta name="description" content="Web development for the rest of us" />
</svelte:head>

<Hero />

<section class="topics">
	<nav class="cta">
		{#each TOPICS as t (t.key)}
			<a href={t.href}>{t.label} docs</a>
		{/each}
	</nav>
</section>

<style>
	.topics {
		max-width: var(--sk-page-content-width);
		margin: 0 auto;
		padding: 2rem var(--sk-page-padding-side) 10rem;
	}
	.cta {
		display: flex;
		gap: 1.2rem;
		justify-content: center;
		flex-wrap: wrap;
	}
	.cta a {
		padding: 1rem 1.8rem;
		border: 1px solid var(--sk-border);
		border-radius: var(--sk-border-radius);
		color: var(--sk-fg-1);
		font: var(--sk-font-ui-medium);
		text-decoration: none;
	}
	.cta a:hover {
		border-color: var(--sk-fg-accent);
		color: var(--sk-fg-accent);
	}
</style>
