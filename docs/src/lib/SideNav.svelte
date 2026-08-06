<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/Logo.svelte';
	import { docsTocItems, playgroundLinks } from '$lib/toc-items';

	// SSR: real Kit `$app/state`. Client island: ogygia shim (location → SPA set_page).
	const initialPath = page.url.pathname;

	let open = $state(false);
	let docsOpen = $state(!initialPath.startsWith('/playground'));
	let playgroundOpen = $state(initialPath.startsWith('/playground'));
	let lastSectionPg = $state(initialPath.startsWith('/playground'));
	let activeToc = $state('features');
	let mobile = $state(false);
	let root_el: HTMLElement | undefined = $state();
	let scroll_el: HTMLElement | undefined = $state();
	/** Skip panel height transition when open state follows a route change. */
	let panelInstant = $state(false);

	const path = $derived(page.url.pathname);
	const onDocs = $derived(path === '/');
	const onPlayground = $derived(path.startsWith('/playground'));
	const sheetInert = $derived(mobile && !open);
	/** On mobile both sections stay expanded; collapse is desktop-only. */
	const docsExpanded = $derived(mobile || docsOpen);
	const playgroundExpanded = $derived(mobile || playgroundOpen);

	function applySectionDefaults(pathname: string) {
		if (mobile) {
			docsOpen = true;
			playgroundOpen = true;
			return;
		}
		const pg = pathname.startsWith('/playground');
		panelInstant = true;
		docsOpen = !pg;
		playgroundOpen = pg;
		queueMicrotask(() => {
			panelInstant = false;
		});
	}

	function close() {
		open = false;
	}

	function toggle() {
		open = !open;
	}

	function docsHref(id: string) {
		return onDocs ? `#${id}` : `/#${id}`;
	}

	function playgroundActive(href: string) {
		if (href === '/playground') return path === '/playground';
		return path === href || path.startsWith(`${href}/`);
	}

	function pickToc() {
		if (!onDocs) return;
		const y = window.scrollY;
		const line = y + 120;
		let next = docsTocItems[0].id;
		for (const item of docsTocItems) {
			const el = document.getElementById(item.id);
			if (!el) continue;
			const top = el.getBoundingClientRect().top + window.scrollY;
			if (top <= line) next = item.id;
		}
		activeToc = next;
	}

	function onDocsLinkClick(id: string) {
		activeToc = id;
		close();
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

	// Docs ↔ Playground boundary only — don't fight manual expand/collapse on sub-routes.
	$effect(() => {
		const pg = path.startsWith('/playground');
		if (pg === lastSectionPg) return;
		lastSectionPg = pg;
		applySectionDefaults(path);
	});

	$effect(() => {
		if (mobile) {
			docsOpen = true;
			playgroundOpen = true;
		}
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

	$effect(() => {
		if (!onDocs || !activeToc || !root_el || (mobile && !open)) return;
		const el = root_el.querySelector<HTMLElement>(`.side-link.is-active`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	$effect(() => {
		pickToc();

		const mq = window.matchMedia('(max-width: 1099px)');
		const syncMobile = () => {
			mobile = mq.matches;
			if (!mq.matches) open = false;
			else {
				docsOpen = true;
				playgroundOpen = true;
			}
		};
		syncMobile();
		mq.addEventListener('change', syncMobile);
		window.addEventListener('resize', syncMobile);
		window.addEventListener('hashchange', pickToc);
		window.addEventListener('scroll', pickToc, { passive: true });

		return () => {
			mq.removeEventListener('change', syncMobile);
			window.removeEventListener('resize', syncMobile);
			window.removeEventListener('hashchange', pickToc);
			window.removeEventListener('scroll', pickToc);
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

	<aside
		class="side"
		class:is-open={open}
		id="side-nav"
		aria-label="Site"
		inert={sheetInert}
	>
		<div class="side-brand">
			<a class="side-logo" href="/" onclick={close}>
				<span class="side-logo-mark" aria-hidden="true"><Logo size={22} /></span>
				<span class="side-logo-word">ogygia</span>
			</a>
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
			{#if mobile}
				<!-- Flat sticky stack: Docs sticks top, Playground sticks bottom then top. -->
				<div class="side-cat-toggle side-cat-toggle--sticky-top" class:is-current={onDocs}>
					<span class="side-cat-label">Docs</span>
				</div>
				<nav class="side-links side-links--mobile-block" aria-label="Docs">
					<ul class="side-list">
						{#each docsTocItems as item (item.id)}
							<li>
								<a
									class="side-link"
									class:side-link--sub={item.sub}
									class:is-active={onDocs && activeToc === item.id}
									href={docsHref(item.id)}
									onclick={() => onDocsLinkClick(item.id)}
								>
									{#if item.sub}<span class="side-link-tick" aria-hidden="true"></span>{/if}
									<span class="side-link-text">{item.label}</span>
								</a>
							</li>
						{/each}
					</ul>
				</nav>

				<div
					class="side-cat-toggle side-cat-toggle--sticky-both"
					class:is-current={onPlayground}
				>
					<span class="side-cat-label">Playground</span>
				</div>
				<nav class="side-links side-links--mobile-block" aria-label="Playground">
					<ul class="side-list">
						{#each playgroundLinks as link}
							<li>
								<a
									class="side-link"
									class:is-active={playgroundActive(link.href)}
									href={link.href}
									onclick={close}
								>
									<span class="side-link-text">{link.label}</span>
								</a>
							</li>
						{/each}
					</ul>
				</nav>
			{:else}
				<section class="side-cat" class:is-current={onDocs}>
					<button
						type="button"
						class="side-cat-toggle"
						aria-expanded={docsOpen}
						onclick={() => (docsOpen = !docsOpen)}
					>
						<span class="side-cat-label">Docs</span>
						<svg
							class="side-chevron"
							class:is-open={docsOpen}
							width="14"
							height="14"
							viewBox="0 0 12 12"
							aria-hidden="true"
						>
							<path
								d="M3 4.5 6 7.5 9 4.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<div
						class="side-cat-panel"
						class:is-open={docsExpanded}
						class:is-instant={panelInstant}
						inert={!docsExpanded}
					>
						<div class="side-cat-panel-inner">
							<nav class="side-links" aria-label="Docs">
								<ul class="side-list">
									{#each docsTocItems as item (item.id)}
										<li>
											<a
												class="side-link"
												class:side-link--sub={item.sub}
												class:is-active={onDocs && activeToc === item.id}
												href={docsHref(item.id)}
												onclick={() => onDocsLinkClick(item.id)}
											>
												{#if item.sub}<span class="side-link-tick" aria-hidden="true"></span>{/if}
												<span class="side-link-text">{item.label}</span>
											</a>
										</li>
									{/each}
								</ul>
							</nav>
						</div>
					</div>
				</section>

				<section class="side-cat" class:is-current={onPlayground}>
					<button
						type="button"
						class="side-cat-toggle"
						aria-expanded={playgroundOpen}
						onclick={() => (playgroundOpen = !playgroundOpen)}
					>
						<span class="side-cat-label">Playground</span>
						<svg
							class="side-chevron"
							class:is-open={playgroundOpen}
							width="14"
							height="14"
							viewBox="0 0 12 12"
							aria-hidden="true"
						>
							<path
								d="M3 4.5 6 7.5 9 4.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<div
						class="side-cat-panel"
						class:is-open={playgroundExpanded}
						class:is-instant={panelInstant}
						inert={!playgroundExpanded}
					>
						<div class="side-cat-panel-inner">
							<nav class="side-links" aria-label="Playground">
								<ul class="side-list">
									{#each playgroundLinks as link}
										<li>
											<a
												class="side-link"
												class:is-active={playgroundActive(link.href)}
												href={link.href}
												onclick={close}
											>
												<span class="side-link-text">{link.label}</span>
											</a>
										</li>
									{/each}
								</ul>
							</nav>
						</div>
					</div>
				</section>
			{/if}
		</div>
	</aside>

	<nav class="side-bottombar" aria-label="Site">
		<a class="side-bottombar-brand" href="/" onclick={close}>
			<span class="side-bottombar-mark" aria-hidden="true"><Logo size={20} /></span>
			<span class="side-bottombar-word">ogygia</span>
		</a>
		<div class="side-bottombar-actions">
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
/* Layout tokens the sidenav reserves on the page. */
:global(:root) {
	--side-w: 16.75rem;
	--side-gap: 0.85rem;
	--side-bar-h: calc(3.25rem + env(safe-area-inset-bottom, 0px));
}

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
	/* Full-height floating panel */
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

.side-github {
	margin-left: auto;
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

.side-cat + .side-cat {
	padding-top: 0.85rem;
	border-top: 1px solid color-mix(in srgb, var(--accent-line) 35%, var(--line));
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
	cursor: pointer;
	text-align: left;
	transition:
		color 160ms ease,
		background 160ms ease;
}

.side-cat-label {
	font: 600 0.6875rem/1 var(--font-mono);
	letter-spacing: 0.12em;
	text-transform: uppercase;
}

.side-cat-toggle:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 32%, transparent);
}

.side-cat.is-current .side-cat-toggle {
	color: var(--accent);
}

.side-chevron {
	display: block;
	width: 14px;
	height: 14px;
	flex-shrink: 0;
	opacity: 0.85;
	transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
	transform: rotate(-90deg);
	/* optical center — stroke path sits slightly high in the viewBox */
	translate: 0 0.5px;
}

.side-cat-toggle:hover .side-chevron,
.side-cat.is-current .side-cat-toggle .side-chevron {
	opacity: 1;
}

.side-chevron.is-open {
	transform: rotate(0deg);
}

.side-cat-panel {
	display: grid;
	grid-template-rows: 0fr;
	opacity: 0;
	transition:
		grid-template-rows 280ms cubic-bezier(0.23, 1, 0.32, 1),
		opacity 200ms ease;
}

.side-cat-panel.is-open {
	grid-template-rows: 1fr;
	opacity: 1;
}

/* Route sync (docs ↔ playground) — snap open/close so SPA View Transitions
   don't hide the live panel mid-collapse and make it flash. */
.side-cat-panel.is-instant {
	transition: none;
}

.side-cat-panel-inner {
	overflow: hidden;
	min-height: 0;
}

@media (prefers-reduced-motion: reduce) {
	.side-cat-panel {
		transition: none;
	}
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

.side-list > li:has(.side-link--sub) + li:has(.side-link:not(.side-link--sub)) {
	margin-top: 0.55rem;
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

.side-link--sub {
	min-height: 1.5rem;
	margin-left: 0.7rem;
	padding: 0.22rem 0.5rem 0.22rem 0.85rem;
	border-radius: 0 8px 8px 0;
	border-left: 1px solid color-mix(in srgb, var(--accent-line) 85%, var(--text-dim));
	font: 400 0.6875rem/1.35 var(--font-mono);
	letter-spacing: -0.01em;
	/* Keep hierarchy without dropping below readable contrast on dark panels */
	color: color-mix(in srgb, var(--text-dim) 78%, var(--text));
}

.side-link-tick {
	position: absolute;
	left: -1px;
	top: 50%;
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: transparent;
	transform: translate(-50%, -50%);
	transition: background 140ms ease;
}

.side-link:hover {
	color: var(--text);
	background: color-mix(in srgb, var(--accent-deep) 42%, transparent);
}

.side-link--sub:hover {
	color: var(--text);
	border-left-color: color-mix(in srgb, var(--accent) 55%, var(--accent-line));
}

.side-link.is-active {
	color: var(--text);
	font-weight: 600;
	background: color-mix(in srgb, var(--accent-deep) 78%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-line) 45%, transparent);
}

.side-link.is-active:not(.side-link--sub)::before {
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

.side-link.is-active:not(.side-link--sub) {
	padding-left: 0.85rem;
}

.side-link--sub.is-active {
	color: var(--accent-strong);
	font-weight: 500;
	background: color-mix(in srgb, var(--accent-deep) 55%, transparent);
	border-left-color: var(--accent);
	box-shadow: none;
}

.side-link--sub.is-active .side-link-tick {
	background: var(--accent);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-deep) 80%, transparent);
}

.side-sheet-handle,
.side-bottombar {
	display: none;
}

@media (min-width: 1100px) {
	:global(body) {
		/* Make room for the floating sidebar so content doesn't sit under it */
		padding-left: calc(var(--side-w) + var(--side-gap) * 2);
	}

	.side-bottombar,
	.side-sheet-handle {
		display: none !important;
	}

	.side-backdrop {
		display: none !important;
	}
}

@media (max-width: 1099px) {
	:global(body) {
		padding-bottom: var(--side-bar-h);
	}

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
		/* Definite height so the scroll pane + sticky headers can fill the sheet. */
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
		padding: 0 0.15rem 0.15rem;
		flex: 1 1 auto;
		min-height: 0;
	}

	/* Docs links fill leftover sheet height so Playground rests on the bottom edge. */
	.side-scroll--mobile > .side-links--mobile-block:first-of-type {
		flex: 1 0 auto;
		min-height: calc(100% - 5rem);
		margin-top: 0.2rem;
		padding-bottom: 0.35rem;
	}

	.side-scroll--mobile > .side-links--mobile-block:last-of-type {
		margin-top: 0.2rem;
		padding-bottom: 0.5rem;
	}

	.side-cat-toggle--sticky-top,
	.side-cat-toggle--sticky-both {
		position: sticky;
		z-index: 3;
		margin: 0;
		border-radius: 0;
		background: color-mix(in srgb, var(--bg-raised) 94%, transparent);
		backdrop-filter: blur(12px) saturate(1.1);
		-webkit-backdrop-filter: blur(12px) saturate(1.1);
		box-shadow: 0 1px 0 color-mix(in srgb, var(--accent-line) 40%, var(--line));
		flex-shrink: 0;
	}

	.side-cat-toggle--sticky-top {
		top: 0;
	}

	/* Bottom while Docs scrolls; top once Playground content takes the sheet. */
	.side-cat-toggle--sticky-both {
		top: 0;
		bottom: 0;
		box-shadow:
			0 -1px 0 color-mix(in srgb, var(--accent-line) 40%, var(--line)),
			0 1px 0 color-mix(in srgb, var(--accent-line) 40%, var(--line));
	}

	.side-cat-toggle--sticky-top.is-current,
	.side-cat-toggle--sticky-both.is-current {
		color: var(--accent);
	}

	.side-cat-toggle--sticky-top.is-current .side-cat-label,
	.side-cat-toggle--sticky-both.is-current .side-cat-label {
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
