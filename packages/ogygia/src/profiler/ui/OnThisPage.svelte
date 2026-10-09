<script lang="ts">
	/**
	 * ON THIS PAGE — a fixed rail on the right listing the report's parts, the one in view lit, click
	 * to jump. A `wake:'load'` island: it reads the rendered `.part` bands from the DOM (no ids
	 * needed — it holds the element refs) and tracks the active one with an IntersectionObserver.
	 * Hidden on narrow screens.
	 */
	// every heading in document order: the part bands (level 0) and each section's h2 (level 1),
	// so the rail is the whole report at a glance, not just the eight parts
	type Entry = { n: string; t: string; el: HTMLElement; level: 0 | 1 };
	let entries = $state<Entry[]>([]);
	let active = $state(0);

	$effect(() => {
		const els = [...document.querySelectorAll<HTMLElement>('.part, .app-main h2')];
		entries = els.map((el) => {
			if (el.classList.contains('part')) return { n: el.querySelector('.part-n')?.textContent ?? '', t: el.querySelector('.part-t')?.textContent ?? '', el, level: 0 as const };
			// an h2's own text, minus the trailing "(hint …)" the sections carry
			const t = (el.childNodes[0]?.textContent ?? el.textContent ?? '').trim();
			return { n: '', t, el, level: 1 as const };
		});
		if (!els.length) return;
		const io = new IntersectionObserver(
			(ents) => {
				for (const e of ents) {
					if (e.isIntersecting) {
						const i = els.indexOf(e.target as HTMLElement);
						if (i >= 0) active = i;
					}
				}
			},
			{ rootMargin: '-6% 0px -85% 0px', threshold: 0 }
		);
		for (const el of els) io.observe(el);
		// the report reserves the rail's space server-side (Shell `toc`); nothing to toggle here
		return () => io.disconnect();
	});
	const jump = (e: Entry) => e.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
</script>

{#if entries.length > 1}
	<nav class="otp" aria-label="on this page">
		<div class="otp-h">On this page</div>
		<ul>
			{#each entries as e, i (i)}
				<li>
					<button class:on={i === active} class:part={e.level === 0} class:sub={e.level === 1} onclick={() => jump(e)}>
						{#if e.n}<span class="n">{e.n}</span>{/if}{e.t}
					</button>
				</li>
			{/each}
		</ul>
	</nav>
{/if}

<style>
	.otp {
		position: fixed;
		right: 16px;
		top: 22px;
		width: 200px;
		max-height: calc(100vh - 40px);
		overflow-y: auto;
		z-index: 8;
	}
	.otp-h {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		padding: 0 0 4px;
	}
	.otp ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.otp button {
		display: flex;
		gap: 7px;
		align-items: baseline;
		width: 100%;
		text-align: left;
		background: none;
		border: 0;
		padding: 2px 0;
		color: var(--text-faint);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		line-height: 1.3;
	}
	.otp button:hover {
		color: var(--text);
	}
	/* the current section: text goes accent + bold, no side marker */
	.otp button.on {
		color: var(--accent-strong);
		font-weight: 600;
	}
	.otp button.part.on {
		color: var(--accent-strong);
	}
	.otp button.part {
		color: var(--text);
		font-weight: 600;
		margin-top: 5px;
	}
	.otp button.part:first-child {
		margin-top: 0;
	}
	.otp button.sub {
		padding-left: 12px;
		font-size: 11.5px;
	}
	.otp .n {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--text-faint);
	}
	.otp button.on .n {
		color: var(--accent);
	}
	/* only show when there's room to the right of the content column */
	@media (max-width: 1500px) {
		.otp {
			display: none;
		}
	}
</style>
