<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		id,
		level = 2,
		class: className = '',
		children
	}: {
		id: string;
		level?: 2 | 3;
		class?: string;
		children: Snippet;
	} = $props();

	const tag = $derived(`h${level}`);
</script>

<svelte:element this={tag} {id} class={['ph', className].filter(Boolean).join(' ')}>
	<span class="ph-text">{@render children()}</span><a
		class="ph-link"
		href={`#${id}`}
		aria-label="Permalink to this section"
	>
		<span class="ph-hash" aria-hidden="true">#</span>
	</a>
</svelte:element>

<style>
	.ph {
		scroll-margin-top: 1.5rem;
	}

	.ph-link {
		display: inline;
		margin-left: 0.4em;
		font-family: var(--font-mono);
		font-style: normal;
		font-weight: 500;
		font-size: 0.7em;
		line-height: 1;
		letter-spacing: 0;
		vertical-align: 0.12em;
		color: var(--text-faint);
		text-decoration: none;
		opacity: 0.45;
		transition:
			opacity 120ms ease,
			color 120ms ease;
	}

	.ph-link:hover,
	.ph-link:focus-visible {
		color: var(--accent);
		opacity: 1;
	}

	.ph-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.ph-link {
			opacity: 0;
		}

		.ph:hover .ph-link,
		.ph:focus-within .ph-link {
			opacity: 0.85;
		}

		.ph:hover .ph-link:hover,
		.ph:focus-within .ph-link:focus-visible {
			opacity: 1;
			color: var(--accent);
		}
	}
</style>
