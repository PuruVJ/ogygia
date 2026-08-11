<script lang="ts">
	import type { Heading } from 'ogygia/content';

	let { headings }: { headings: Heading[] } = $props();

	// Set from the first pick() on mount; starts empty to avoid capturing the prop's initial value.
	let activeId = $state('');
	let raf = 0;

	function pick() {
		const line = window.scrollY + 120;
		let next = headings[0]?.id ?? '';
		for (const h of headings) {
			const el = document.getElementById(h.id);
			if (el && el.getBoundingClientRect().top + window.scrollY <= line) next = h.id;
		}
		activeId = next;
	}

	function schedule() {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			pick();
		});
	}

	$effect(() => {
		schedule();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		return () => {
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			if (raf) cancelAnimationFrame(raf);
		};
	});
</script>

{#if headings.length}
	<nav class="toc" aria-label="On this page">
		<p class="toc-label">On this page</p>
		<ul class="toc-list">
			{#each headings as h (h.id)}
				<li>
					<a
						class="toc-link"
						class:toc-link--sub={h.depth >= 3}
						class:is-active={activeId === h.id}
						href={`#${h.id}`}
					>
						<span class="toc-tick" aria-hidden="true"></span>
						<span class="toc-text">{h.text}</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>
{/if}

<style>
	/* Positioning is owned by the eager .doc-aside (sticky) so the rail stays fixed
	   from first paint even before this island's CSS loads. */
	.toc {
		max-height: calc(100dvh - 3rem);
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--line-strong) transparent;
	}

	.toc-label {
		margin: 0 0 0.6rem;
		padding-left: 0.7rem;
		font: 600 0.6875rem/1 var(--font-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-dim);
	}

	.toc-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		border-left: 1px solid color-mix(in srgb, var(--accent-line) 60%, var(--line));
	}

	.toc-link {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 1.5rem;
		padding: 0.22rem 0.5rem 0.22rem 0.85rem;
		margin-left: -1px;
		border-left: 1px solid transparent;
		font: 400 0.6875rem/1.35 var(--font-mono);
		letter-spacing: -0.01em;
		color: color-mix(in srgb, var(--text-dim) 78%, var(--text));
		text-decoration: none;
		transition:
			color 140ms ease,
			border-color 140ms ease;
	}

	.toc-link--sub {
		padding-left: 1.35rem;
	}

	.toc-link:hover {
		color: var(--text);
		border-left-color: color-mix(in srgb, var(--accent) 55%, var(--accent-line));
	}

	.toc-link.is-active {
		color: var(--accent-strong);
		border-left-color: var(--accent);
	}

	.toc-tick {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: transparent;
		flex-shrink: 0;
		transition: background 140ms ease;
	}

	.toc-link.is-active .toc-tick {
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-deep) 80%, transparent);
	}

	.toc-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 1099px) {
		.toc {
			display: none;
		}
	}
</style>
