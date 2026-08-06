<script lang="ts">
	import Logo from '$lib/Logo.svelte';
	import { docsTocItems, playgroundLinks } from '$lib/toc-items';

	let open = $state(false);
	let docsOpen = $state(true);
	let playgroundOpen = $state(true);
	let path = $state('/');
	let activeToc = $state('features');
	let mobile = $state(false);
	let root_el: HTMLElement | undefined = $state();

	const onDocs = $derived(path === '/');
	const onPlayground = $derived(path.startsWith('/playground'));
	const sheetInert = $derived(mobile && !open);

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

	function syncLocation() {
		path = location.pathname;
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

	$effect(() => {
		if (!onDocs || !activeToc || !root_el) return;
		const el = root_el.querySelector<HTMLElement>(`.side-link.is-active`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	$effect(() => {
		syncLocation();
		pickToc();

		const mq = window.matchMedia('(max-width: 1099px)');
		const syncMobile = () => {
			mobile = mq.matches;
			if (!mq.matches) open = false;
		};
		syncMobile();
		mq.addEventListener('change', syncMobile);

		const onPop = () => {
			syncLocation();
			pickToc();
		};
		window.addEventListener('popstate', onPop);
		window.addEventListener('hashchange', onPop);
		window.addEventListener('scroll', pickToc, { passive: true });

		const push = history.pushState.bind(history);
		const replace = history.replaceState.bind(history);
		history.pushState = (...args: Parameters<History['pushState']>) => {
			push(...args);
			syncLocation();
		};
		history.replaceState = (...args: Parameters<History['replaceState']>) => {
			replace(...args);
			syncLocation();
		};

		return () => {
			mq.removeEventListener('change', syncMobile);
			window.removeEventListener('popstate', onPop);
			window.removeEventListener('hashchange', onPop);
			window.removeEventListener('scroll', pickToc);
			history.pushState = push;
			history.replaceState = replace;
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
				<Logo size={20} />
				<span>ogygia</span>
			</a>
			<a
				class="side-github"
				href="https://github.com/PuruVJ/ogygia"
				aria-label="GitHub repository"
				target="_blank"
				rel="noreferrer"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path
						d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
					/>
				</svg>
			</a>
		</div>

		<div class="side-scroll">
			<section class="side-cat" class:is-current={onDocs}>
				<button
					type="button"
					class="side-cat-toggle"
					aria-expanded={docsOpen}
					onclick={() => (docsOpen = !docsOpen)}
				>
					<span>Docs</span>
					<svg
						class="side-chevron"
						class:is-open={docsOpen}
						width="12"
						height="12"
						viewBox="0 0 12 12"
						aria-hidden="true"
					>
						<path
							d="M3 4.5 6 7.5 9 4.5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="square"
						/>
					</svg>
				</button>
				{#if docsOpen}
					<nav class="side-links" aria-label="Docs">
						{#each docsTocItems as item (item.id)}
							<a
								class="side-link"
								class:side-link--sub={item.sub}
								class:is-active={onDocs && activeToc === item.id}
								href={docsHref(item.id)}
								onclick={() => onDocsLinkClick(item.id)}
							>
								{item.label}
							</a>
						{/each}
					</nav>
				{/if}
			</section>

			<section class="side-cat" class:is-current={onPlayground}>
				<button
					type="button"
					class="side-cat-toggle"
					aria-expanded={playgroundOpen}
					onclick={() => (playgroundOpen = !playgroundOpen)}
				>
					<span>Playground</span>
					<svg
						class="side-chevron"
						class:is-open={playgroundOpen}
						width="12"
						height="12"
						viewBox="0 0 12 12"
						aria-hidden="true"
					>
						<path
							d="M3 4.5 6 7.5 9 4.5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="square"
						/>
					</svg>
				</button>
				{#if playgroundOpen}
					<nav class="side-links" aria-label="Playground">
						{#each playgroundLinks as link}
							<a
								class="side-link"
								class:is-active={playgroundActive(link.href)}
								href={link.href}
								onclick={close}
							>
								{link.label}
							</a>
						{/each}
					</nav>
				{/if}
			</section>
		</div>
	</aside>

	<button
		type="button"
		class="side-fab"
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
