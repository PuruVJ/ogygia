<aside class="toc" aria-label="On this page">
	<div class="toc-marker" style:transform="translateY({markerY}px)"></div>
	{#each items as item (item.id)}
		<a
			class="toc-item"
			class:toc-item--sub={item.sub}
			class:is-active={active === item.id}
			href="#{item.id}"
			data-toc={item.id}
		>
			{item.label}
		</a>
	{/each}
</aside>

<script lang="ts">
	const items = [
		{ id: 'what', label: 'What it does', sub: false },
		{ id: 'install', label: 'Install', sub: false },
		{ id: 'authoring', label: 'Authoring', sub: false },
		{ id: 'strategies', label: 'Strategies', sub: false },
		{ id: 'client-load', label: "hydrate: 'load'", sub: true },
		{ id: 'client-idle', label: "hydrate: 'idle'", sub: true },
		{ id: 'client-visible', label: "hydrate: 'visible'", sub: true },
		{ id: 'client-media', label: 'hydrate: media', sub: true },
		{ id: 'server-islands', label: 'Server islands', sub: false },
		{ id: 'lakes', label: 'Lakes', sub: false },
		{ id: 'data', label: 'Data & remotes', sub: false },
		{ id: 'router', label: 'SPA router', sub: false },
		{ id: 'patterns', label: 'Pesky patterns', sub: false },
		{ id: 'constraints', label: 'Constraints', sub: false }
	] as const;

	const OFFSET_DOWN = 110;
	const OFFSET_UP = 175;

	let active = $state<string>('what');
	let markerY = $state(0);
	let lastY = 0;

	function syncMarker(id: string) {
		const link = document.querySelector<HTMLElement>(`[data-toc="${id}"]`);
		if (link) markerY = link.offsetTop + link.offsetHeight / 2;
	}

	function pickActive() {
		const y = window.scrollY;
		const goingDown = y >= lastY;
		lastY = y;
		const line = y + (goingDown ? OFFSET_DOWN : OFFSET_UP);

		let next: string = items[0].id;
		for (const item of items) {
			const el = document.getElementById(item.id);
			if (!el) continue;
			const top = el.getBoundingClientRect().top + window.scrollY;
			if (top <= line) next = item.id;
		}

		if (next !== active) {
			active = next;
			syncMarker(next);
		}
	}

	$effect(() => {
		const host = document.querySelector('.toc-fixed');
		const hero = document.querySelector('.hero');

		const showToc = (on: boolean) => {
			host?.classList.toggle('is-on', on);
			host?.setAttribute('aria-hidden', on ? 'false' : 'true');
		};

		// Appear only after the hero has scrolled away.
		let gate: IntersectionObserver | undefined;
		if (hero) {
			gate = new IntersectionObserver(
				([entry]) => {
					showToc(!Boolean(entry?.isIntersecting));
				},
				{ rootMargin: '-64px 0px 0px 0px', threshold: 0 }
			);
			gate.observe(hero);
		}

		pickActive();
		syncMarker(active);

		const onScroll = () => pickActive();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);

		return () => {
			gate?.disconnect();
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			showToc(false);
		};
	});
</script>
