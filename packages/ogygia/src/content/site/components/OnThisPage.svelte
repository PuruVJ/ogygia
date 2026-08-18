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
	 * your own active state); `.og-toc*` hooks for CSS.
	 */
	import { on } from 'svelte/events';
	import type { Snippet } from 'svelte';
	import { roving } from './roving.js';
	import type { Heading } from '../types.js';

	let {
		headings,
		title,
		label = 'On this page',
		scrollspy = true,
		item
	}: {
		headings: Heading[];
		/** The page title, shown as the FIRST entry (linking back to the top) — so the outline exists
		 *  even on a page with no headings, and reads like svelte.dev's. Active when nothing below
		 *  the fold is. */
		title?: string;
		label?: string;
		/** Highlight the section currently in view (default `true`). */
		scrollspy?: boolean;
		item?: Snippet<[Heading]>;
	} = $props();

	let active = $state('');

	// The "top" entry is a real link to the current page (so it's a valid href, not a bare `#`), but
	// clicking it just scrolls to the top — no navigation. Server-safe default for the SSR pass.
	const top_href = $derived(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/');
	function to_top(e: MouseEvent) {
		e.preventDefault();
		window.scrollTo({ top: 0, behavior: 'smooth' });
		history.replaceState(history.state, '', top_href);
	}

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
			// Slide the rail thumb to the active link's box. Drive this island's own list AND the
			// mobile inline outline — a static `<details class="og-mtoc">` (Doc.svelte) with no
			// scrollspy of its own, so on mobile it gets the same active row + moving thumb.
			const move_thumb = (ul: HTMLElement | null, set_active: boolean) => {
				if (!ul) return;
				// The island's own list uses Svelte's `class:og-active`; only the static list needs this.
				if (set_active) ul.querySelectorAll('.og-active').forEach((a) => a.classList.remove('og-active'));
				const lnk = best ? ul.querySelector<HTMLElement>(`a[href="#${CSS.escape(best)}"]`) : null;
				if (lnk) {
					if (set_active) lnk.classList.add('og-active');
					ul.style.setProperty('--og-thumb-y', `${lnk.offsetTop}px`);
					ul.style.setProperty('--og-thumb-h', `${lnk.offsetHeight}px`);
					ul.classList.add('og-has-active');
				} else {
					ul.classList.remove('og-has-active');
				}
			};
			move_thumb(list, false);
			move_thumb(document.querySelector('.og-mtoc .og-toc-list'), true);
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

{#if headings.length || title}
	<nav class="og-toc" aria-label={label}>
		<p class="og-toc-label">{label}</p>
		<ul class="og-toc-list" {@attach spy} {@attach roving({ selector: '.og-toc-link', orientation: 'vertical' })}>
			{#if title}
				<!-- The document top: a valid same-page link, but click just scrolls up (no nav). Active
				     whenever no heading is. -->
				<li class="og-toc-item og-toc-d2 og-toc-title">
					<a class="og-toc-link" class:og-active={active === ''} href={top_href} onclick={to_top} aria-current={active === '' ? 'true' : undefined}>{title}</a>
				</li>
			{/if}
			{#each headings as h (h.id)}
				<li class={`og-toc-item og-toc-d${h.depth}`}>
					{#if item}{@render item(h)}{:else}
						<a
							class="og-toc-link"
							class:og-active={h.id === active}
							href={`#${h.id}`}
							aria-current={h.id === active ? 'true' : undefined}>{h.text}</a
						>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>
{/if}
