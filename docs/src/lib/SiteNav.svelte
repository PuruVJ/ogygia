<script lang="ts">
	import Logo from '$lib/Logo.svelte';

	type NavLink = {
		href: string;
		label: string;
		/** Show an outbound arrow (e.g. docs → playground). */
		outbound?: boolean;
	};

	let {
		brandHref = '/',
		brandLabel = 'ogygia',
		links,
		github = false
	}: {
		brandHref?: string;
		brandLabel?: string;
		links: NavLink[];
		github?: boolean;
	} = $props();

	let open = $state(false);
	let root_el: HTMLElement | undefined = $state();

	function close() {
		open = false;
	}

	function toggle() {
		open = !open;
	}

	$effect(() => {
		if (!open) return;

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};

		// Pointer / focus outside the bar + sheet closes the menu.
		const onPointer = (e: PointerEvent) => {
			const t = e.target;
			if (!(t instanceof Node) || !root_el) return;
			if (!root_el.contains(t)) close();
		};

		const onFocus = (e: FocusEvent) => {
			const t = e.target;
			if (!(t instanceof Node) || !root_el) return;
			if (!root_el.contains(t)) close();
		};

		document.addEventListener('keydown', onKey);
		// capture so we see the event before anything stops it
		document.addEventListener('pointerdown', onPointer, true);
		document.addEventListener('focusin', onFocus, true);

		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('focusin', onFocus, true);
			document.body.style.overflow = prev;
		};
	});
</script>

<div class="nav-root" class:nav-root--open={open} bind:this={root_el}>
	<!-- Backdrop is a sibling of the bar (not inside it) so fixed + filter don't trap it -->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="nav-backdrop"
		class:is-open={open}
		onclick={close}
		aria-hidden={!open}
	></div>

	<div
		class="nav-sheet"
		class:is-open={open}
		id="nav-sheet"
		inert={!open}
		aria-hidden={!open}
	>
		{#each links as link}
			<a
				class="nav-drawer-link"
				class:nav-drawer-link--out={link.outbound}
				href={link.href}
				tabindex={open ? 0 : -1}
				onclick={close}
			>
				{link.label}
				{#if link.outbound}
					<svg
						class="nav-out"
						width="14"
						height="14"
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M4 12.5 12.5 4M6.5 4H12.5V10"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="square"
						/>
					</svg>
				{/if}
			</a>
		{/each}
		{#if github}
			<a
				class="nav-drawer-link"
				href="https://github.com/PuruVJ/ogygia"
				target="_blank"
				rel="noreferrer"
				tabindex={open ? 0 : -1}
				onclick={close}
			>
				GitHub
				<svg
					class="nav-out"
					width="14"
					height="14"
					viewBox="0 0 16 16"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M4 12.5 12.5 4M6.5 4H12.5V10"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="square"
					/>
				</svg>
			</a>
		{/if}
	</div>

	<nav class="nav" class:nav--open={open}>
		<div class="shell nav-inner">
			<a class="nav-brand" href={brandHref} onclick={close}>
				<Logo size={20} />
				<span class="nav-wordmark">{brandLabel}</span>
			</a>

			<div class="nav-links">
				{#each links as link}
					<a class="nav-link" class:nav-link--out={link.outbound} href={link.href}>
						{link.label}
						{#if link.outbound}
							<svg
								class="nav-out"
								width="11"
								height="11"
								viewBox="0 0 16 16"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M4 12.5 12.5 4M6.5 4H12.5V10"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="square"
								/>
							</svg>
						{/if}
					</a>
				{/each}
			</div>

			{#if github}
				<a
					class="nav-github"
					href="https://github.com/PuruVJ/ogygia"
					aria-label="GitHub repository"
					target="_blank"
					rel="noreferrer"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path
							d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
						/>
					</svg>
				</a>
			{/if}

			<button
				type="button"
				class="nav-burger"
				aria-label={open ? 'Close menu' : 'Open menu'}
				aria-expanded={open}
				aria-controls="nav-sheet"
				onclick={toggle}
			>
				<span class="nav-burger-bars" aria-hidden="true">
					<span></span>
					<span></span>
					<span></span>
				</span>
			</button>
		</div>
	</nav>
</div>
