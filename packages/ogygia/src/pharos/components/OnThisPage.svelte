<script lang="ts">
	/**
	 * On-this-page headings with scrollspy. Meant to be mounted as an ISLAND (`with { wake: 'load' }`)
	 * so it's a real reactive component: it hydrates per page and RE-hydrates after every SPA
	 * navigation, so the active marker just works on the new page — no inline `script()`, no dependence
	 * on scripts re-running across a body swap.
	 *
	 * The scrollspy lives in an ATTACHMENT on the list (runs on mount, cleans up on unmount) using
	 * `svelte/events` `on()` for the window listeners. It marks the last heading above the fold line as
	 * active and slides the rail thumb to it. Customize each row with the `item` snippet (then apply
	 * your own active state); `.ph-toc*` hooks for CSS.
	 */
	import { on } from 'svelte/events';
	import type { Snippet } from 'svelte';
	import { roving } from './roving.js';
	import type { Heading } from '../types.js';

	let {
		headings,
		label = 'On this page',
		scrollspy = true,
		item
	}: {
		headings: Heading[];
		label?: string;
		/** Highlight the section currently in view (default `true`). */
		scrollspy?: boolean;
		item?: Snippet<[Heading]>;
	} = $props();

	let active = $state('');

	/** Attachment: wire the scrollspy to the rendered list. Returns a teardown Svelte calls on unmount. */
	function spy(list: HTMLElement) {
		if (!scrollspy || !headings.length) return;
		const ids = headings.map((h) => h.id);
		let raf = 0;
		const pick = () => {
			raf = 0;
			const seen: Array<{ id: string; top: number }> = [];
			for (const id of ids) {
				const el = document.getElementById(id);
				if (el) seen.push({ id, top: el.getBoundingClientRect().top });
			}
			if (!seen.length) return;
			let best = '';
			for (const s of seen) {
				if (s.top <= 120) best = s.id;
				else break;
			}
			// Short page: nothing crossed the fold but the first heading is up in view → active.
			if (!best && seen[0].top <= innerHeight * 0.4) best = seen[0].id;
			// At the very bottom, the last section is what you're reading.
			if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) best = seen[seen.length - 1].id;
			active = best;
			// Slide the clerk-style rail thumb to the active link's box.
			const link = best ? list.querySelector(`a[href="#${CSS.escape(best)}"]`) : null;
			if (link instanceof HTMLElement) {
				list.style.setProperty('--ph-thumb-y', `${link.offsetTop}px`);
				list.style.setProperty('--ph-thumb-h', `${link.offsetHeight}px`);
				list.classList.add('ph-has-active');
			} else {
				list.classList.remove('ph-has-active');
			}
		};
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(pick);
		};
		const off_scroll = on(window, 'scroll', onScroll, { passive: true });
		const off_resize = on(window, 'resize', onScroll, { passive: true });
		pick();
		return () => {
			off_scroll();
			off_resize();
			cancelAnimationFrame(raf);
		};
	}
</script>

{#if headings.length}
	<nav class="ph-toc" aria-label={label}>
		<p class="ph-toc-label">{label}</p>
		<ul class="ph-toc-list" {@attach spy} {@attach roving({ selector: '.ph-toc-link', orientation: 'vertical' })}>
			{#each headings as h (h.id)}
				<li class={`ph-toc-item ph-toc-d${h.depth}`}>
					{#if item}{@render item(h)}{:else}
						<a
							class="ph-toc-link"
							class:ph-active={h.id === active}
							href={`#${h.id}`}
							aria-current={h.id === active ? 'true' : undefined}>{h.text}</a
						>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>
{/if}
