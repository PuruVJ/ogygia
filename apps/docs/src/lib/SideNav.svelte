<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Logo from '$lib/Logo.svelte';
	import { docNav } from '$lib/docs.remote';
	import { groupNav, docHref } from '$lib/toc-items';

	// Nav is a prerendered remote — cheap static JSON, grouped into ordered sections.
	const groups = groupNav(await docNav());

	// Theme switcher: light | system | dark. A no-flash inline script in the layout applies a forced
	// theme before paint; this just reflects/cycles it. 'system' clears the attribute → prefers-color.
	let theme = $state<'system' | 'light' | 'dark'>('system');
	onMount(() => {
		try {
			const t = localStorage.getItem('ogygia-theme');
			if (t === 'light' || t === 'dark' || t === 'system') theme = t;
		} catch {
			/* private mode */
		}
	});
	const themeLabel = $derived(
		theme === 'light' ? 'Light theme' : theme === 'dark' ? 'Dark theme' : 'System theme'
	);
	function cycleTheme() {
		theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
		try {
			localStorage.setItem('ogygia-theme', theme);
		} catch {
			/* ignore */
		}
		const root = document.documentElement;
		if (theme === 'system') root.removeAttribute('data-theme');
		else root.setAttribute('data-theme', theme);
	}

	let open = $state(false);
	let mobile = $state(false);
	let root_el: HTMLElement | undefined = $state();
	let scroll_el: HTMLElement | undefined = $state();

	const path = $derived(page.url.pathname);
	const sheetInert = $derived(mobile && !open);

	function sectionHasActive(items: { slug: string }[]) {
		return items.some((i) => path === docHref(i.slug));
	}

	function isActive(slug: string) {
		return path === docHref(slug);
	}

	function close() {
		open = false;
	}
	function toggle() {
		open = !open;
	}

	function scrollActiveIntoView() {
		const root = scroll_el;
		if (!root) return;
		const el = root.querySelector<HTMLElement>('.side-link.is-active');
		if (!el) return;
		const rootRect = root.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const delta = elRect.top - rootRect.top - rootRect.height / 2 + elRect.height / 2;
		root.scrollTop += delta;
	}

	$effect(() => {
		const mq = window.matchMedia('(max-width: 1099px)');
		const sync = () => {
			mobile = mq.matches;
			if (!mq.matches) open = false;
		};
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	$effect(() => {
		if (!open || !mobile) return;
		const t1 = window.setTimeout(scrollActiveIntoView, 40);
		const t2 = window.setTimeout(scrollActiveIntoView, 360);
		return () => {
			clearTimeout(t1);
			clearTimeout(t2);
		};
	});

	// Keep the active nav link visible WITHIN the sidebar's own scroll box only.
	// `element.scrollIntoView()` would also scroll the document (jumping the page down to
	// wherever the active link sits) — scrollActiveIntoView only touches scroll_el.scrollTop.
	$effect(() => {
		// Reading `path` makes this re-run on navigation too — the sidebar is `keep`-persisted, so it
		// never remounts, and without this the active item would only be centred on the first load.
		void path;
		if (!root_el || (mobile && !open)) return;
		const id = requestAnimationFrame(scrollActiveIntoView);
		// Fallback once layout has settled (fonts/async island hydrate can shift row heights).
		const t = window.setTimeout(scrollActiveIntoView, 140);
		return () => {
			cancelAnimationFrame(id);
			clearTimeout(t);
		};
	});

	$effect(() => {
		if (!open) return;

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};
		const onPointer = (e: PointerEvent) => {
			const t = e.target;
			if (!(t instanceof Node) || !root_el) return;
			if (!root_el.contains(t)) close();
		};

		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onPointer, true);
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onPointer, true);
			document.body.style.overflow = prev;
		};
	});
</script>

<div class="side-root" class:side-root--open={open} bind:this={root_el}>
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="side-backdrop" class:is-open={open} onclick={close} aria-hidden={!open}></div>

	<aside class="side" class:is-open={open} id="side-nav" aria-label="Site" inert={sheetInert}>
		<div class="side-brand">
			<a class="side-logo" href="/" onclick={close}>
				<span class="side-logo-mark" aria-hidden="true"><Logo size={22} /></span>
				<span class="side-logo-word">ogygia</span>
			</a>
			<span
				class="side-nuke"
				title="Experimental — the API may still change"
				role="img"
				aria-label="Experimental"
			>
				<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
					<circle cx="12" cy="12" r="2.3" />
					<path
						d="M12 1a11 11 0 0 0-5.5 1.47l3.5 6.06a4 4 0 0 1 4 0l3.5-6.06A11 11 0 0 0 12 1Zm10.53 16.5-6.06-3.5a4 4 0 0 1-2 3.46l3.5 6.07a11 11 0 0 0 4.56-6.03ZM6.03 23.53l3.5-6.07a4 4 0 0 1-2-3.46l-6.06 3.5a11 11 0 0 0 4.56 6.03Z"
					/>
				</svg>
			</span>
			<button
				type="button"
				class="side-theme"
				onclick={cycleTheme}
				aria-label={themeLabel}
				title={themeLabel}
			>
				{#if theme === 'light'}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
					</svg>
				{:else if theme === 'dark'}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
					</svg>
				{:else}
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
						<rect x="2" y="4" width="20" height="13" rx="2" />
						<path d="M8 21h8M12 17v4" />
					</svg>
				{/if}
			</button>
			<a
				class="side-github"
				href="https://github.com/PuruVJ/ogygia"
				aria-label="GitHub repository"
				target="_blank"
				rel="noreferrer"
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
					/>
				</svg>
			</a>
		</div>

		<div class="side-sheet-handle" aria-hidden="true"><span></span></div>

		<div class="side-scroll" class:side-scroll--mobile={mobile} bind:this={scroll_el}>
			<a
				class="side-home-link"
				class:is-active={path === '/'}
				href="/"
				onclick={close}
			>
				<span class="side-link-text">Home</span>
			</a>

			{#each groups as group (group.section)}
				{#if mobile}
					<div
						class="side-cat-toggle side-cat-toggle--sticky-top"
						class:is-current={sectionHasActive(group.items)}
					>
						<span class="side-cat-label">{group.section}</span>
					</div>
					<nav class="side-links side-links--mobile-block" aria-label={group.section}>
						<ul class="side-list">
							{#each group.items as item (item.slug)}
								<li>
									<a
										class="side-link"
										class:is-active={isActive(item.slug)}
										href={docHref(item.slug)}
										onclick={close}
									>
										<span class="side-link-text">{item.title}</span>
									</a>
								</li>
							{/each}
						</ul>
					</nav>
				{:else}
					<section class="side-cat" class:is-current={sectionHasActive(group.items)}>
						<div class="side-cat-header">
							<span class="side-cat-label">{group.section}</span>
						</div>
						<nav class="side-links" aria-label={group.section}>
							<ul class="side-list">
								{#each group.items as item (item.slug)}
									<li>
										<a
											class="side-link"
											class:is-active={isActive(item.slug)}
											href={docHref(item.slug)}
											onclick={close}
										>
											<span class="side-link-text">{item.title}</span>
										</a>
									</li>
								{/each}
							</ul>
						</nav>
					</section>
				{/if}
			{/each}
		</div>
	</aside>

	<nav class="side-bottombar" aria-label="Site">
		<div class="side-bottombar-lead">
			<a class="side-bottombar-brand" href="/" onclick={close}>
				<span class="side-bottombar-mark" aria-hidden="true"><Logo size={20} /></span>
				<span class="side-bottombar-word">ogygia</span>
			</a>
			<span
				class="side-bottombar-nuke"
				title="Experimental — the API may still change"
				role="img"
				aria-label="Experimental"
			>
				<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
					<circle cx="12" cy="12" r="2.3" />
					<path
						d="M12 1a11 11 0 0 0-5.5 1.47l3.5 6.06a4 4 0 0 1 4 0l3.5-6.06A11 11 0 0 0 12 1Zm10.53 16.5-6.06-3.5a4 4 0 0 1-2 3.46l3.5 6.07a11 11 0 0 0 4.56-6.03ZM6.03 23.53l3.5-6.07a4 4 0 0 1-2-3.46l-6.06 3.5a11 11 0 0 0 4.56 6.03Z"
					/>
				</svg>
			</span>
		</div>
		<div class="side-bottombar-actions">
			<button
				type="button"
				class="side-bottombar-theme"
				onclick={cycleTheme}
				aria-label={themeLabel}
				title={themeLabel}
			>
				{#if theme === 'light'}
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
					</svg>
				{:else if theme === 'dark'}
					<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
					</svg>
				{:else}
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
						<rect x="2" y="4" width="20" height="13" rx="2" />
						<path d="M8 21h8M12 17v4" />
					</svg>
				{/if}
			</button>
			<a
				class="side-bottombar-github"
				href="https://github.com/PuruVJ/ogygia"
				aria-label="GitHub repository"
				target="_blank"
				rel="noreferrer"
			>
				<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
					/>
				</svg>
			</a>
			<button
				type="button"
				class="side-bottombar-menu"
				aria-label={open ? 'Close menu' : 'Open menu'}
				aria-expanded={open}
				aria-controls="side-nav"
				onclick={toggle}
			>
				<span class="side-fab-bars" aria-hidden="true">
					<span></span>
					<span></span>
					<span></span>
				</span>
			</button>
		</div>
	</nav>
</div>

<style>
/* Layout tokens + body padding reservation live in site-chrome.css (eager) so content does not
   shift when this island's CSS loads. */

.side-backdrop {
	display: none;
}

.side {
	position: fixed;
	z-index: 50;
	display: flex;
	flex-direction: column;
	gap: 0.85rem;
	width: var(--side-w);
	top: var(--side-gap);
	bottom: var(--side-gap);
	left: var(--side-gap);
	padding: 0.85rem 0.55rem 0.9rem 0.7rem;
	border: 1px solid color-mix(in srgb, var(--accent-line) 55%, var(--line));
	border-radius: 14px;
	background:
		linear-gradient(
			165deg,
			color-mix(in srgb, var(--accent-deep) 28%, transparent) 0%,
			transparent 42%
		),
		color-mix(in srgb, var(--bg-raised) 92%, transparent);
	box-shadow:
		var(--shadow-panel),
		inset 0 1px 0 color-mix(in srgb, var(--accent) 8%, transparent);
	backdrop-filter: blur(16px) saturate(1.15);
	-webkit-backdrop-filter: blur(16px) saturate(1.15);
}

.side-brand {
	display: flex;
	align-items: center;
	gap: 0.35rem;
	padding: 0.2rem 0.4rem 0.75rem;
	border-bottom: 1px solid color-mix(in srgb, var(--accent-line) 40%, var(--line));
	flex-shrink: 0;
}

/* Radiation trefoil next to the wordmark — "handle with care, experimental". Hover shows the
   tooltip via `title`. An icon, not a pill, so nothing collides with the italic serif. */
.side-nuke {
	display: inline-flex;
	flex-shrink: 0;
	color: var(--accent);
	cursor: help;
	opacity: 0.85;
	transition: opacity 140ms ease;
}
.side-nuke:hover {
	opacity: 1;
}

.side-logo {
	display: inline-flex;
	align-items: center;
	gap: 0.55rem;
	min-width: 0;
	color: var(--accent);
	text-decoration: none;
}

.side-logo-mark {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 1.75rem;
	height: 1.75rem;
	border-radius: 8px;
	background: color-mix(in srgb, var(--accent-deep) 70%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-line) 70%, transparent);
	flex-shrink: 0;
}

.side-logo-word {
	color: var(--text);
	font-family: var(--font-display);
	font-style: italic;
	font-weight: 500;
	font-size: 1.2rem;
	line-height: 1;
	letter-spacing: -0.02em;
	font-variation-settings: 'opsz' 28;
	padding-bottom: 0.06em;
}

.side-theme {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2rem;
	height: 2rem;
	padding: 0;
	color: var(--text-faint);
	background: none;
	border-radius: 8px;
	border: 1px solid transparent;
	flex-shrink: 0;
	cursor: pointer;
	transition:
		color 160ms ease,
		background 160ms ease,
		border-color 160ms ease;
}

.side-theme:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 45%, transparent);
	border-color: color-mix(in srgb, var(--accent-line) 55%, transparent);
}

.side-github {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2rem;
	height: 2rem;
	color: var(--text-faint);
	border-radius: 8px;
	border: 1px solid transparent;
	flex-shrink: 0;
	transition:
		color 160ms ease,
		background 160ms ease,
		border-color 160ms ease;
}

.side-github:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 45%, transparent);
	border-color: color-mix(in srgb, var(--accent-line) 55%, transparent);
}

.side-scroll {
	display: flex;
	flex-direction: column;
	gap: 1.15rem;
	min-height: 0;
	flex: 1;
	overflow-x: hidden;
	overflow-y: auto;
	scrollbar-width: thin;
	scrollbar-color: var(--line-strong) transparent;
	padding: 0.1rem 0.2rem 0.35rem 0.05rem;
}

.side-home-link {
	display: flex;
	align-items: center;
	min-height: 1.85rem;
	padding: 0.32rem 0.55rem 0.32rem 0.7rem;
	border-radius: 8px;
	font: 500 0.84375rem/1.25 var(--font-body);
	letter-spacing: -0.014em;
	color: var(--text-dim);
	text-decoration: none;
	transition:
		color 140ms ease,
		background 140ms ease;
}

.side-home-link:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 42%, transparent);
}

.side-home-link.is-active {
	color: var(--text);
	font-weight: 600;
	background: color-mix(in srgb, var(--accent-deep) 78%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-line) 45%, transparent);
}

.side-cat + .side-cat {
	padding-top: 0.85rem;
	border-top: 1px solid color-mix(in srgb, var(--accent-line) 35%, var(--line));
}

/* Static, non-collapsible category header (desktop). Mobile reuses `.side-cat-toggle` +
   `--sticky-top` for its sticky section labels. */
.side-cat-header {
	padding: 0.4rem 0.45rem;
}

.side-cat-toggle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
	width: 100%;
	padding: 0.4rem 0.45rem;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: var(--text-dim);
	text-align: left;
}

.side-cat-label {
	font: 600 0.6875rem/1 var(--font-mono);
	letter-spacing: 0.12em;
	text-transform: uppercase;
	color: var(--text-dim);
}

.side-cat.is-current .side-cat-label {
	color: var(--accent);
}

.side-links {
	margin-top: 0.35rem;
}

.side-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 0.1rem;
}

.side-link {
	position: relative;
	display: flex;
	align-items: center;
	gap: 0.4rem;
	min-height: 1.85rem;
	padding: 0.32rem 0.55rem 0.32rem 0.7rem;
	border-radius: 8px;
	font: 500 0.84375rem/1.25 var(--font-body);
	letter-spacing: -0.014em;
	color: var(--text-dim);
	text-decoration: none;
	transition:
		color 140ms ease,
		background 140ms ease,
		box-shadow 140ms ease;
}

.side-link-text {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.side-link:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 42%, transparent);
}

.side-link.is-active {
	color: var(--text);
	font-weight: 600;
	background: color-mix(in srgb, var(--accent-deep) 78%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-line) 45%, transparent);
}

.side-link.is-active::before {
	content: '';
	position: absolute;
	left: 0.35rem;
	top: 0.4rem;
	bottom: 0.4rem;
	width: 2px;
	border-radius: 1px;
	background: var(--accent);
	pointer-events: none;
}

.side-link.is-active {
	padding-left: 0.85rem;
}

.side-sheet-handle,
.side-bottombar {
	display: none;
}

@media (min-width: 1100px) {
	.side-bottombar,
	.side-sheet-handle {
		display: none !important;
	}

	.side-backdrop {
		display: none !important;
	}
}

@media (max-width: 1099px) {
	.side {
		top: auto;
		left: 0;
		right: 0;
		bottom: var(--side-bar-h);
		width: 100%;
		max-width: none;
		max-height: min(78dvh, calc(100dvh - var(--side-bar-h) - 0.35rem));
		gap: 0.35rem;
		padding: 0.35rem 0.65rem 0.55rem;
		border-radius: 16px 16px 0 0;
		border-left: 0;
		border-right: 0;
		border-bottom: 0;
		transform: translate3d(0, calc(100% + 0.75rem), 0);
		pointer-events: none;
		visibility: hidden;
		transition:
			transform 340ms cubic-bezier(0.23, 1, 0.32, 1),
			visibility 340ms;
	}

	.side.is-open {
		transform: translate3d(0, 0, 0);
		pointer-events: auto;
		visibility: visible;
		height: min(78dvh, calc(100dvh - var(--side-bar-h) - 0.35rem));
	}

	.side-brand {
		display: none;
	}

	.side-sheet-handle {
		display: flex;
		justify-content: center;
		padding: 0.2rem 0 0.35rem;
		flex-shrink: 0;
	}

	.side-sheet-handle span {
		display: block;
		width: 2.25rem;
		height: 4px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-faint) 55%, var(--line-strong));
	}

	.side-scroll--mobile {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0.25rem 0.35rem 0.5rem;
		flex: 1 1 auto;
		min-height: 0;
	}

	/* Bigger touch targets + higher contrast for the phone sheet. */
	.side-scroll--mobile .side-home-link,
	.side-scroll--mobile .side-link {
		min-height: 2.75rem;
		padding-left: 0.9rem;
		border-radius: 10px;
		font-size: 0.95rem;
		color: color-mix(in srgb, var(--text-dim) 55%, var(--text));
	}

	.side-scroll--mobile .side-link.is-active {
		color: var(--text);
	}

	/* Section headings: a real heading (bigger than the links), with a divider line above each
	   section. No background, not sticky — plain text differentiation. */
	.side-cat-toggle--sticky-top {
		margin: 1.4rem 0 0.15rem;
		padding: 0.95rem 0.6rem 0.3rem;
		border-radius: 0;
		border-top: 1px solid color-mix(in srgb, var(--accent-line) 26%, var(--line));
		background: none;
		flex-shrink: 0;
	}

	.side-scroll--mobile .side-cat-label {
		font: 700 1.05rem/1.2 var(--font-display);
		letter-spacing: -0.01em;
		text-transform: none;
		color: var(--text);
	}

	.side-cat-toggle--sticky-top.is-current .side-cat-label {
		color: var(--accent);
	}

	.side-backdrop {
		display: block;
		position: fixed;
		inset: 0;
		bottom: var(--side-bar-h);
		z-index: 40;
		background: color-mix(in srgb, #000 48%, transparent);
		opacity: 0;
		pointer-events: none;
		transition: opacity 280ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.side-backdrop.is-open {
		opacity: 1;
		pointer-events: auto;
	}

	.side-bottombar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 60;
		height: var(--side-bar-h);
		padding: 0 0.85rem env(safe-area-inset-bottom, 0px);
		border-top: 1px solid color-mix(in srgb, var(--accent-line) 50%, var(--line));
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--accent-deep) 18%, transparent) 0%,
				transparent 70%
			),
			color-mix(in srgb, var(--bg-raised) 94%, transparent);
		box-shadow: 0 -8px 28px -18px rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(16px) saturate(1.15);
		-webkit-backdrop-filter: blur(16px) saturate(1.15);
	}

	.side-bottombar-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		color: var(--accent);
		text-decoration: none;
	}

	.side-bottombar-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.65rem;
		height: 1.65rem;
		border-radius: 7px;
		background: color-mix(in srgb, var(--accent-deep) 70%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-line) 70%, transparent);
		flex-shrink: 0;
	}

	.side-bottombar-word {
		color: var(--text);
		font-family: var(--font-display);
		font-style: italic;
		font-weight: 500;
		font-size: 1.125rem;
		line-height: 1;
		letter-spacing: -0.02em;
		font-variation-settings: 'opsz' 28;
		padding-bottom: 0.05em;
	}

	.side-bottombar-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		flex-shrink: 0;
	}

	.side-bottombar-lead {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.side-bottombar-nuke {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--accent);
		opacity: 0.85;
		cursor: help;
	}

	.side-bottombar-theme {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		color: var(--text-dim);
		border: 1px solid transparent;
		border-radius: 10px;
		background: none;
		cursor: pointer;
	}

	.side-bottombar-theme:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--accent-deep) 40%, transparent);
		border-color: color-mix(in srgb, var(--accent-line) 40%, transparent);
	}

	.side-bottombar-github {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		color: var(--text-dim);
		border: 1px solid transparent;
		border-radius: 10px;
		text-decoration: none;
	}

	.side-bottombar-github:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--accent-deep) 40%, transparent);
		border-color: color-mix(in srgb, var(--accent-line) 40%, transparent);
	}

	.side-bottombar-menu {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		margin: 0;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--accent-line) 45%, var(--line));
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent-deep) 35%, transparent);
		color: var(--text);
		cursor: pointer;
		flex-shrink: 0;
	}

	.side-bottombar-menu:hover {
		background: color-mix(in srgb, var(--accent-deep) 55%, transparent);
	}

	.side-root--open .side-fab-bars span:nth-child(1) {
		transform: translateY(5.5px) rotate(45deg);
	}

	.side-root--open .side-fab-bars span:nth-child(2) {
		opacity: 0;
	}

	.side-root--open .side-fab-bars span:nth-child(3) {
		transform: translateY(-5.5px) rotate(-45deg);
	}

	.side-fab-bars {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		width: 18px;
		height: 12px;
	}

	.side-fab-bars span {
		display: block;
		height: 1.5px;
		width: 100%;
		background: currentColor;
		transform-origin: center;
		transition:
			transform 200ms cubic-bezier(0.23, 1, 0.32, 1),
			opacity 120ms ease;
	}

	@media (prefers-reduced-motion: reduce) {
		.side {
			transition: none;
		}
	}
}
</style>
