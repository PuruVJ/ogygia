<script lang="ts">
	/**
	 * The interactive half of TabGroup — an ISLAND (TabGroup wraps it `with { wake: 'load' }`). The tab
	 * PANELS arrive as `children` frozen to static server HTML (a region snippet crossed the island
	 * boundary), so they never re-render. This island renders ONLY the panels on the server — clean,
	 * mismatch-free — then on mount BUILDS the bar from the panels' own `data-label`s and wires the full
	 * WCAG tablist keyboard (roving tabindex, arrow wrap, Home/End, MANUAL activation — arrows rove,
	 * Space/Enter select). Because the
	 * labels come from the panels, hand-authored `<Tab label>` and injected `:::` blocks work identically,
	 * with no `labels` prop to thread. Site-wide memory rides {@link ./tab-groups.svelte.ts}.
	 *
	 * (Bits `Tabs` was tried for the bar, but its SSR/client id generation mismatches when hydrated inside
	 * the frozen-children island; the tablist pattern is small and fully verified here.)
	 */
	import { untrack } from 'svelte';
	import { on } from 'svelte/events';
	import { roving } from './roving.js';
	import { tab_group, hydrate_group } from './tab-groups.svelte.js';
	import type { Snippet } from 'svelte';

	let { group = 'tabs', children }: { group?: string; children: Snippet } = $props();
	const g = $derived(tab_group(group));

	function control(root: HTMLElement) {
		const panels = [...root.querySelectorAll<HTMLElement>('.og-tabs-panel')];
		const labels = panels.map((p) => p.dataset.label ?? '');
		if (!labels.length) return;

		const bar = document.createElement('div');
		bar.className = 'og-tabs-bar';
		bar.setAttribute('role', 'tablist');
		const marker = document.createElement('span');
		marker.className = 'og-tabs-marker';
		marker.setAttribute('aria-hidden', 'true');
		bar.appendChild(marker);
		const btns = labels.map((label) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'og-tabs-tab';
			btn.setAttribute('role', 'tab');
			btn.dataset.label = label;
			btn.textContent = label;
			bar.appendChild(btn);
			return btn;
		});
		root.insertBefore(bar, root.firstChild); // CSS `order` lifts it above the panels

		const place = (i: number) => {
			const b = btns[i];
			if (!b) return;
			if (!marker.dataset.init) marker.style.transition = 'none';
			marker.style.transform = `translateX(${b.offsetLeft - bar.clientLeft}px)`;
			marker.style.width = `${b.offsetWidth}px`;
			marker.style.opacity = '1';
			if (!marker.dataset.init) {
				marker.dataset.init = '1';
				void marker.offsetWidth;
				marker.style.transition = '';
			}
		};
		// DOM-only state application — never writes the store. The attachment must not depend on
		// `g.value`: a tracked read would re-run the whole attachment on every selection (teardown +
		// rebuild), which destroys the marker mid-flight and kills its slide animation.
		const apply = (i: number, focus = false) => {
			panels.forEach((p, j) => (p.hidden = j !== i));
			btns.forEach((b, j) => {
				b.setAttribute('aria-selected', String(j === i));
				b.tabIndex = j === i ? 0 : -1;
			});
			place(i);
			if (focus) btns[i].focus();
		};
		const activate = (i: number, focus = false) => {
			apply(i, focus);
			try {
				g.value = labels[i]; // shared store: every same-group block follows + persists
			} catch {
				/* store set never throws, but keep the DOM update resilient */
			}
		};

		const off1 = on(bar, 'click', (e) => {
			const t = (e.target as Element).closest('.og-tabs-tab');
			if (t) activate(btns.indexOf(t as HTMLButtonElement), true);
		});
		// MANUAL activation (WAI-ARIA tablist): the SHARED roving primitive moves focus on
		// arrows/Home/End (focus-only — it seeds the tab stop from `aria-selected`); Space/Enter select
		// via the native `<button>` click above. Selecting on arrow would yank the panel out from under
		// someone just browsing the tab names.
		const off2 = roving({ selector: '.og-tabs-tab', orientation: 'horizontal' })(bar) ?? (() => {});
		const off3 = on(window, 'resize', () => place(btns.findIndex((b) => b.getAttribute('aria-selected') === 'true')));

		// Initial state, UNTRACKED — the attachment stays dependency-free (see `apply`).
		untrack(() => {
			hydrate_group(group, labels[0]); // restore a saved choice post-hydration
			const start = Math.max(0, labels.indexOf(g.value ?? labels[0]));
			activate(start);
			if (document.fonts?.ready) document.fonts.ready.then(() => place(start));
		});
		// Site-wide group sync WITH the slide: a nested effect tracks ONLY `g.value` and applies it to
		// the existing DOM — the bar is never rebuilt, so the marker glides here too.
		$effect(() => {
			const v = g.value;
			untrack(() => {
				const i = labels.indexOf(v ?? '');
				if (i >= 0 && btns[i]?.getAttribute('aria-selected') !== 'true') apply(i);
			});
		});

		return () => {
			off1();
			off2();
			off3();
			bar.remove();
		};
	}
</script>

<div class="og-tabs" data-group={group} {@attach control}>
	<div class="og-tabs-panels">{@render children()}</div>
</div>
