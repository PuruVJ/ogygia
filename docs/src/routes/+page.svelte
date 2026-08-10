<script lang="ts">
	import Contours from '$lib/Contours.svelte';
	// The hero demo hydrates on load; the showcase islands below each hydrate on the exact schedule
	// their code shows, so `/` is itself a live demo of the library.
	import HeroDemo from '$lib/demos/HeroDemo.svelte' with { wake: 'load' };
	import PageHead from '$lib/PageHead.svelte';
	import Features from '$lib/Features.svelte';
	import SiteFooter from '$lib/SiteFooter.svelte';
	import ShowcaseCard from '$lib/ShowcaseCard.svelte';
	// Each showcase demo IS a real island using the strategy it documents.
	import Counter from '$lib/demos/Counter.svelte' with { wake: 'load' };
	import IdleClock from '$lib/demos/IdleClock.svelte' with { wake: 'idle' };
	import VisibleWidget from '$lib/demos/VisibleWidget.svelte' with { wake: 'visible' };
	import MediaWidget from '$lib/demos/MediaWidget.svelte' with { wake: '(max-width: 600px)' };
	import ServerGreeting from '$lib/demos/ServerGreeting.svelte' with { fill: 'load' };
	import FrozenCounter from '$lib/demos/FrozenCounter.svelte';
	import PartialSearch from '$lib/demos/PartialSearch.svelte' with { wake: 'load' };
	import LivePartialDemo from '$lib/demos/LivePartialDemo.svelte' with { wake: 'load' };
	// Two separate island bundles sharing one live object passed as a prop (static [ogygia.wire]).
	import SharedAdd from '$lib/demos/SharedAdd.svelte' with { wake: 'load' };
	import SharedCount from '$lib/demos/SharedCount.svelte' with { wake: 'load' };
	import { Cart } from '$lib/demos/cart-store.svelte.js';
	import '$lib/styles/widget.css';

	let { data }: { data: import('./$types').PageData } = $props();

	// One instance, handed to both islands below.
	const cart = new Cart();
</script>

<PageHead
	description="The islands library for SvelteKit. No Kit client bootstrap — a ~7.6 KB runtime (custom element + router), and JS only for the components you mark. Server islands, lakes, partials, and content collections are all the same island."
/>

<div id="top"></div>

<header class="hero">
	<Contours class="hero-contours" />
	<div class="shell hero-grid">
		<div class="hero-copy">
			<h1>ogygia</h1>
			<p class="hero-tagline">
				SSR islands for SvelteKit
				<span class="hero-say" aria-label="pronounced oh-jee-jee-ya">oh-jee-jee-ya</span>
			</p>
			<p>
				No Kit client bootstrap. The shared runtime is a custom element plus an optional router —
				about <strong>7.6&nbsp;KB</strong> min+brotli. Mark components with an import attribute and
				they become interactive on a schedule; everything else stays server HTML.
			</p>
			<div class="btn-row">
				<a class="btn btn--primary" href="/docs/start/adoption">Adoption</a>
				<a class="btn btn--ghost" href="/docs/start/install">Install</a>
				<a
					class="btn btn--ghost"
					href="https://github.com/PuruVJ/ogygia"
					target="_blank"
					rel="noreferrer">GitHub</a
				>
			</div>
		</div>
		<div class="hero-demo">
			<HeroDemo codeHtml={data.heroCode} />
		</div>
	</div>
</header>

<Features />

<section class="shell showcase" aria-labelledby="showcase">
	<div class="showcase-head">
		<h2 id="showcase">One primitive, many shapes</h2>
		<p>
			Every demo here is a real island on this page, hydrating on the exact schedule its code shows.
			Islands, server islands, lakes, and partials are all the same thing, shaped differently.
		</p>
	</div>

	<div class="showcase-grid">
		<ShowcaseCard title="Client island" tag="wake: 'load'" codeHtml={data.loadCode}>
			{#snippet demo()}
				<Counter start={10} label="Load island" />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard title="Idle island" tag="wake: 'idle'" codeHtml={data.idleCode}>
			{#snippet demo()}
				<IdleClock />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard title="Visible island" tag="wake: 'visible'" codeHtml={data.visibleCode}>
			{#snippet demo()}
				<VisibleWidget />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Media island"
			tag="wake: media"
			marker="live under 600px"
			codeHtml={data.mediaCode}
		>
			{#snippet demo()}
				<MediaWidget />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Server island"
			tag="fill: 'load'"
			marker="server HTML, fetched late"
			codeHtml={data.serverCode}
		>
			{#snippet demo()}
				<ServerGreeting salutation="Aloha">
					{#snippet ogygiaFallback()}
						<p class="widget-meta">fetching…</p>
					{/snippet}
				</ServerGreeting>
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Lake"
			tag="wake: 'none'"
			marker="frozen · 0 KB JS"
			codeHtml={data.lakeCode}
		>
			{#snippet demo()}
				<FrozenCounter start={42} note="SSR HTML, no client JS" />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Partial"
			tag="server-chosen UI"
			marker="server picks the component"
			codeHtml={data.fragmentCode}
			stack
		>
			{#snippet demo()}
				<PartialSearch />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Live partial"
			tag="query.live + await"
			marker="server pushes HTML · morphs in place"
			codeHtml={data.livePartialCode}
			stack
		>
			{#snippet demo()}
				<LivePartialDemo />
			{/snippet}
		</ShowcaseCard>

		<ShowcaseCard
			title="Shared object"
			tag="static [ogygia.wire]"
			marker="one live object · two islands"
			offMarker="server HTML · 0 KB JS"
			codeHtml={data.sharedObjectCode}
			stack
		>
			{#snippet demo()}
				<div class="showcase-pair">
					<SharedCount {cart} />
					<SharedAdd {cart} />
				</div>
			{/snippet}
			{#snippet frozen()}
				<div class="showcase-pair">
					<div class="widget" data-shared-count>
						<span class="widget-label">Count island</span>
						<div class="widget-row">
							<span class="widget-value">0</span>
							<span class="widget-meta">items in the shared cart</span>
						</div>
					</div>
					<div class="widget" data-shared-add>
						<span class="widget-label">Add island</span>
						<div class="widget-row">
							<button type="button" disabled>Add to cart</button>
						</div>
						<p class="widget-meta">separate bundle from the count</p>
					</div>
				</div>
			{/snippet}
		</ShowcaseCard>
	</div>
</section>

<main class="shell home-docs">
	<div class="home-docs-head">
		<h2>Start here</h2>
		<p>The full guide moved into the docs, split by topic with live demos inline. Pick a track.</p>
	</div>
	<div class="home-docs-grid">
		<a class="home-docs-card" href="/docs/start/overview">
			<span class="home-docs-kicker">Start</span>
			<span class="home-docs-title">The model, install, adoption</span>
		</a>
		<a class="home-docs-card" href="/docs/islands/client-islands">
			<span class="home-docs-kicker">Islands</span>
			<span class="home-docs-title">Client &amp; server islands, lakes, portable bindings</span>
		</a>
		<a class="home-docs-card" href="/docs/data-state/remote-functions">
			<span class="home-docs-kicker">App</span>
			<span class="home-docs-title">Remote functions, the SPA router, plugin config</span>
		</a>
		<a class="home-docs-card" href="/docs/content/collections">
			<span class="home-docs-kicker">Content</span>
			<span class="home-docs-title">RF-native collections, markdown, live sources</span>
		</a>
		<a class="home-docs-card" href="/docs/reference/patterns">
			<span class="home-docs-kicker">Reference</span>
			<span class="home-docs-title">Pesky patterns and constraints</span>
		</a>
	</div>
</main>

<SiteFooter meta="ogygia · MIT · named for Calypso's island">
	{#snippet links()}
		<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
		<a href="https://www.npmjs.com/package/ogygia" target="_blank" rel="noreferrer">npm</a>
	{/snippet}
</SiteFooter>

<style>
	.showcase {
		padding-block: 4rem 1rem;
	}

	.showcase-head {
		max-width: 44rem;
		margin-bottom: 2.5rem;
	}

	.showcase-head h2 {
		margin: 0 0 0.5rem;
		font: 600 1.75rem/1.15 var(--font-display);
		letter-spacing: -0.03em;
		color: var(--text);
	}

	.showcase-head p {
		margin: 0;
		color: var(--text-dim);
		line-height: 1.6;
	}

	.showcase-grid {
		display: grid;
		gap: 1.5rem;
	}

	.home-docs {
		padding-block: 4rem 6rem;
	}

	.home-docs-head {
		max-width: 42rem;
		margin-bottom: 2.5rem;
	}

	.home-docs-head h2 {
		margin: 0 0 0.5rem;
		font: 600 1.75rem/1.15 var(--font-display);
		letter-spacing: -0.03em;
		color: var(--text);
	}

	.home-docs-head p {
		margin: 0;
		color: var(--text-dim);
		line-height: 1.6;
	}

	.home-docs-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 1rem;
	}

	.home-docs-card {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 1.25rem 1.35rem;
		border: 1px solid color-mix(in srgb, var(--accent-line) 45%, var(--line));
		border-radius: 12px;
		background: color-mix(in srgb, var(--bg-raised) 60%, transparent);
		text-decoration: none;
		transition:
			border-color 160ms ease,
			background 160ms ease,
			transform 160ms ease;
	}

	.home-docs-card:hover {
		border-color: color-mix(in srgb, var(--accent-line) 80%, var(--accent));
		background: color-mix(in srgb, var(--accent-deep) 22%, var(--bg-raised));
		transform: translateY(-2px);
	}

	.home-docs-kicker {
		font: 600 0.6875rem/1 var(--font-mono);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.home-docs-title {
		color: var(--text);
		font: 500 0.9375rem/1.4 var(--font-body);
		letter-spacing: -0.01em;
	}

	.hero {
		position: relative;
		overflow: clip;
		min-height: 100dvh;
		display: grid;
		align-items: center;
		padding-top: 2.5rem;
		padding-bottom: 4rem;
	}

	.hero-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(260px, 0.9fr);
		gap: clamp(1.5rem, 3vw, 2.75rem);
		align-items: center;
	}

	.hero-copy {
		min-width: 0;
	}

	.hero-copy p {
		font-size: 1.0625rem;
		max-width: 48ch;
	}

	.hero-tagline {
		margin: 0.35rem 0 1.25rem;
		font: 500 1.125rem/1.35 var(--font-body);
		color: var(--accent);
		letter-spacing: -0.01em;
		max-width: none;
	}

	.hero-say {
		display: inline-block;
		margin-left: 0.65rem;
		padding-left: 0.65rem;
		border-left: 1px solid var(--line-strong);
		font: 400 0.8125rem/1.35 var(--font-mono);
		letter-spacing: 0.02em;
		color: var(--text-faint);
		vertical-align: 0.05em;
	}

	:global(.hero-contours) {
		position: absolute;
		top: 50%;
		right: -120px;
		width: min(520px, 55vw);
		transform: translateY(-50%);
		opacity: 0.35;
		pointer-events: none;
		color: var(--line-strong);
	}

	.hero-demo {
		transform: none;
		position: relative;
		z-index: 1;
		min-width: 0;
	}


	@media (max-width: 1023px) {
		.hero-grid {
			grid-template-columns: 1fr !important;
		}

		.hero-demo {
			transform: none !important;
		}

		:global(.hero-contours) {
			opacity: 0.2;
			right: -320px;
		}
	}

	@media (max-width: 1099px) {
		.hero {
			padding-top: 2rem;
			min-height: 100dvh;
		}
	}

	.showcase-pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	@media (max-width: 520px) {
		.showcase-pair {
			grid-template-columns: 1fr;
		}
	}
</style>
