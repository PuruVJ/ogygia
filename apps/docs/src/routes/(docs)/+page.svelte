<script lang="ts">
	import Contours from '$lib/Contours.svelte';
	import { Region } from 'ogygia';
	import {
		heroCode, heroCodeHtml, loadCode, visibleCode, lakeCode, serverCode, fragmentCode,
		livePartialCode, sharedObjectCode, contentCollectionCode, contentMarkdownCode,
		contentJsonCode, contentCustomCode, dimensionsCode, composeCode
	} from '$lib/code/snippets';
	// The hero demo hydrates on load; the showcase islands below each hydrate on the exact schedule
	// their code shows, so `/` is itself a live demo of the library.
	import HeroDemo from '$lib/demos/HeroDemo.svelte' with { wake: 'load' };
	import PageHead from '$lib/PageHead.svelte';
	import SiteFooter from '$lib/SiteFooter.svelte';
	import ShowcaseCard from '$lib/ShowcaseCard.svelte';
	// Each showcase demo IS a real island using the strategy it documents.
	import Counter from '$lib/demos/Counter.svelte' with { wake: 'load' };
	import IdleClock from '$lib/demos/IdleClock.svelte' with { wake: 'idle' };
	import VisibleWidget from '$lib/demos/VisibleWidget.svelte' with { wake: 'visible' };
	import MediaWidget from '$lib/demos/MediaWidget.svelte' with { wake: '(max-width: 600px)' };
	import InteractionWidget from '$lib/demos/InteractionWidget.svelte' with { wake: 'interaction' };
	import ServerGreeting from '$lib/demos/ServerGreeting.svelte' with { render: 'deferred' };
	import FrozenCounter from '$lib/demos/FrozenCounter.svelte';
	import PartialSearch from '$lib/demos/PartialSearch.svelte' with { wake: 'load' };
	import LivePartialDemo from '$lib/demos/LivePartialDemo.svelte' with { wake: 'load' };
	// Two separate island bundles sharing one live object passed as a prop (static [ogygia.wire]).
	import SharedAdd from '$lib/demos/SharedAdd.svelte' with { wake: 'load' };
	import SharedCount from '$lib/demos/SharedCount.svelte' with { wake: 'load' };
	import ContentPeek from '$lib/demos/ContentPeek.svelte' with { wake: 'load' };
	import { Cart } from '$lib/demos/cart-store.svelte.js';
	import '$lib/styles/widget.css';


	// One instance, handed to both islands below.
	const cart = new Cart();
</script>

<PageHead
	home
	description="The islands library for SvelteKit. No Kit client bootstrap — a lightweight runtime (custom element + router), and JS only for the components you mark. Server islands, lakes, held regions, and content collections are all the same region."
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
				Your pages are HTML. Nothing hydrates until you say so. Mark a component and it wakes:
				on load, on scroll, on whatever cue you pick. Everything else stays static. No Kit client
				to boot, so you ship JavaScript only for what you marked.
			</p>
			<div class="btn-row">
				<a class="btn btn--primary" href="/docs/start/overview">Getting started</a>
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
			<HeroDemo code={heroCodeHtml} />
		</div>
	</div>
</header>

<section class="shell story" aria-labelledby="story">
	<div class="story-intro">
		<span class="story-kicker">How it works</span>
		<h2 id="story">Your pages are static HTML. You pick what hydrates.</h2>
		<p>
			Every demo below is real, running on this page as you scroll. It starts with one island and
			keeps building, one idea at a time, until a whole site runs on nothing more than this.
		</p>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">01</span>
			<h3>One attribute wakes a component</h3>
			<p>
				Add <code>wake: 'load'</code> to an import. That one component wakes up. Everything
				around it is just HTML. Kill the JavaScript and only the island stops.
			</p>
		</div>
		<ShowcaseCard title="Client island" tag="wake: 'load'" code={loadCode}>
			{#snippet demo()}
				<Counter start={10} label="Load island" />
			{/snippet}
			{#snippet frozen()}
				<FrozenCounter start={10} note="Static HTML — JS is off" />
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">02</span>
			<h3>It wakes when you decide, not all at once</h3>
			<p>
				Same attribute, different cue: <code>load</code>, <code>idle</code>, <code>visible</code>, a
				media query. Each island's JavaScript waits for its own. Mostly-static pages stay cheap.
			</p>
		</div>
		<ShowcaseCard
			title="Schedules"
			tag="idle · visible · media · interaction"
			marker="each wakes on its own trigger"
			code={visibleCode}
			stack
		>
			{#snippet demo()}
				<div class="beat-tiles">
					<IdleClock />
					<VisibleWidget />
					<MediaWidget />
					<InteractionWidget />
				</div>
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">03</span>
			<h3>Freeze what never moves</h3>
			<p>
				Renders once and never moves? Mark it <code>wake: 'none'</code>. Server HTML, and not a
				byte in the client bundle. That is a <strong>lake</strong>.
			</p>
		</div>
		<ShowcaseCard title="Lake" tag="wake: 'none'" marker="frozen · 0 KB JS" code={lakeCode}>
			{#snippet demo()}
				<FrozenCounter start={42} note="SSR HTML, no client JS" />
			{/snippet}
		</ShowcaseCard>
	</div>

	<p class="story-turn">That is the whole client side. Now hand the work to the server.</p>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">04</span>
			<h3>Hand a hole to the server</h3>
			<p>
				<code>render: 'deferred'</code> makes a server island. Rendered per request, personalized,
				no client bundle. It fetches its own HTML after the shell paints.
			</p>
		</div>
		<ShowcaseCard
			title="Server island"
			tag="render: 'deferred'"
			marker="server HTML, fetched late"
			code={serverCode}
		>
			{#snippet demo()}
				<ServerGreeting salutation="Aloha">
					{#snippet ogygiaFallback()}
						<p class="widget-meta">fetching…</p>
					{/snippet}
				</ServerGreeting>
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">05</span>
			<h3>Let the server choose the component</h3>
			<p>
				A <strong>held region</strong> goes further. The server picks <em>which</em> component,
				signs the HTML, and sends it. The client paints it and never imports the options.
			</p>
		</div>
		<ShowcaseCard
			title="Held region"
			tag="server picks the UI"
			marker="server chooses the component"
			code={fragmentCode}
			stack
		>
			{#snippet demo()}
				<PartialSearch />
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">06</span>
			<h3>And push it, live</h3>
			<p>
				<code>query.live</code> re-renders on every tick. The server pushes HTML down the wire; the
				client <strong>morphs</strong> it in place. No fetch code, no polling.
			</p>
		</div>
		<ShowcaseCard
			title="Live region"
			tag="query.live"
			marker="server pushes HTML · morphs in place"
			code={livePartialCode}
			stack
		>
			{#snippet demo()}
				<LivePartialDemo />
			{/snippet}
		</ShowcaseCard>
	</div>

	<p class="story-turn">Every region so far stands on its own. They can also share one live object.</p>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">07</span>
			<h3>Share one object across islands</h3>
			<p>
				Two island bundles, one live object passed as a prop. The button writes, the counter
				reads. No store, no event bus.
			</p>
		</div>
		<ShowcaseCard
			title="Shared object"
			tag="static [ogygia.wire]"
			marker="one live object · two islands"
			offMarker="server HTML · 0 KB JS"
			code={sharedObjectCode}
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

<section class="shell content-story" aria-labelledby="content-story">
	<div class="content-head">
		<span class="story-kicker">Content</span>
		<h2 id="content-story">Your content is a collection</h2>
		<p>
			The same idea covers your writing. Define a collection once with <code>content()</code>,
			backed by markdown, JSON, or a CMS. You query it over the wire like any other remote
			function, and the bodies never ship to the client. What you render is a region, so your
			content wakes on the same schedules as everything else. These docs run on it.
		</p>
	</div>

	<div class="content-showcase">
		<ShowcaseCard
			title="Content collection"
			tag="ogygia/content"
			marker="live over the wire · no bodies shipped"
			code={contentCollectionCode}
			stack
		>
			{#snippet demo()}
				<ContentPeek />
			{/snippet}
		</ShowcaseCard>
	</div>

	<p class="content-lead">One <code>content()</code> definition; the source decides where it comes from.</p>

	<div class="content-beats">
		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">01</span>
				<span class="content-eyebrow">Markdown &amp; islands</span>
				<h3>Prose with live components in it</h3>
			</div>
			<figure class="content-code">
				<div class="demo-code"><Region of={contentMarkdownCode} /></div>
				<a class="content-code-link" href="/docs/content/collections">Markdown &amp; Shiki →</a>
			</figure>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">02</span>
				<span class="content-eyebrow">Typed data</span>
				<h3>JSON through the same API</h3>
			</div>
			<figure class="content-code">
				<div class="demo-code"><Region of={contentJsonCode} /></div>
				<a class="content-code-link" href="/docs/content/collections">Collections →</a>
			</figure>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">03</span>
				<span class="content-eyebrow">Any source, even live</span>
				<h3>A CMS, a REST API, a push feed</h3>
			</div>
			<figure class="content-code">
				<div class="demo-code"><Region of={contentCustomCode} /></div>
				<a class="content-code-link" href="/docs/content/blocks">Blocks &amp; custom sources →</a>
			</figure>
		</div>
	</div>
</section>

<section class="live-shell" aria-labelledby="live-shell-h">
	<div class="shell">
		<div class="content-head live-shell-head">
			<span class="story-kicker">Site kit</span>
			<h2 id="live-shell-h">Everything above becomes a whole site</h2>
			<p>
				This is where it lands. Hand <code>site()</code> a collection and <code>DocsShell</code>
				gives you the rest: nav built from filenames, prev/next, full-text search, versioning and
				translations, <code>sitemap.xml</code> and <code>llms.txt</code>. The frame below is live.
				Search it (hit <kbd>/</kbd>), switch the version or language, restyle it. This whole site
				runs on it.
			</p>
		</div>
	</div>

	<figure class="live-frame">
		<div class="live-frame-bar">
			<span class="live-frame-dots"><i></i><i></i><i></i></span>
			<span class="live-frame-url">ogygia playground · DocsShell</span>
			<a class="live-frame-open" href="/playground/getting-started/installation" target="_blank" rel="noreferrer">Open in full ↗</a>
		</div>
		<iframe
			class="live-frame-view"
			src="/playground/getting-started/installation"
			title="ogygia playground — DocsShell running live"
			loading="lazy"
		></iframe>
	</figure>
</section>

<section class="shell content-story" aria-labelledby="blocks-story">
	<div class="content-head">
		<span class="story-kicker">Too opinionated?</span>
		<h2 id="blocks-story">Then take it apart</h2>
		<p>
			DocsShell is one composition of public parts. Keep it and swap a single region for a snippet,
			or drop to <code>Frame</code> and build your own shell from the same bricks. Versioning and
			translations aren't bolted on either: they're one primitive, <code>dimensions</code>.
		</p>
	</div>

	<div class="content-beats">
		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">01</span>
				<span class="content-eyebrow">Dimensions</span>
				<h3>Versioning and i18n, one primitive</h3>
				<p>
					The V2 and EN switchers you just used? Declare the axes and hand back one outline per
					coordinate. The URLs, the switchers, and per-locale fallback come with it.
					<a href="/docs/content/dimensions">Dimensions →</a>
				</p>
			</div>
			<figure class="content-code">
				<div class="demo-code"><Region of={dimensionsCode} /></div>
			</figure>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">02</span>
				<span class="content-eyebrow">Composition</span>
				<h3>Swap a region, or the whole shell</h3>
				<p>
					Every region of the shell is a snippet prop: leave it out for the built-in, pass a
					snippet to replace it, pass <code>null</code> to remove it. Want to start from nothing?
					<code>Frame</code> is the same shell with none of the decisions made for you.
					<a href="/docs/content/shell">Shells →</a>
				</p>
			</div>
			<figure class="content-code">
				<div class="demo-code"><Region of={composeCode} /></div>
			</figure>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">03</span>
				<span class="content-eyebrow">The bricks</span>
				<h3>Every part imports on its own</h3>
				<p>
					<code>Sidebar</code>, <code>OnThisPage</code>, <code>Search</code>, <code>Switcher</code>,
					<code>Pager</code>, <code>ThemeToggle</code>, <code>Doc</code>, <code>TabGroup</code>.
					Each one is tree-shakeable, and ships zero CSS until you import it.
					<a href="/docs/content/shell">Components →</a>
				</p>
			</div>
		</div>
	</div>

	<p class="content-lead">Start with everything: <code>npx ogygia site init</code>. Keep only what you use.</p>
</section>

<section class="shell applayer" aria-labelledby="applayer">
	<div class="story-intro">
		<span class="story-kicker">The app layer</span>
		<h2 id="applayer">And it is still a fast app</h2>
		<p>
			The shell is what you see. Underneath, ogygia makes the page itself fast: prerender the
			shell, batch the server holes, and navigate like a single-page app, all without writing
			extra client code.
		</p>
	</div>

	<div class="applayer-beats">
	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">01</span>
			<h3>Bake the shell, fill the holes</h3>
			<p>
				Partial prerendering serves a static file from the CDN, with server islands fetched live
				per visitor. A reload demo shows one page telling two times.
				<a href="/docs/app/router">Partial prerendering →</a>
			</p>
		</div>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">02</span>
			<h3>One request per navigation</h3>
			<p>
				The SPA router pulls a whole page's server-island holes down one batch, out of order, with no
				waterfall. <a href="/docs/app/router#single-flight">Single-flight navigation →</a>
			</p>
		</div>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">03</span>
			<h3>Mutate and repaint in one trip</h3>
			<p>
				A command returns its re-rendered region in the same response, so the mounted region morphs
				with no follow-up fetch. <a href="/docs/regions/held-regions">Single-flight →</a>
			</p>
		</div>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">04</span>
			<h3>Prerender the next page on hover</h3>
			<p>
				Native Speculation Rules run the next page's JS and holes in a hidden tab, so the click is
				instant. <a href="/docs/app/router#speculate">Speculation →</a>
			</p>
		</div>
	</div>
	</div>
</section>

<!-- A <section>, not <main>: the Shell's `.og-cmain` is the page's one main landmark. -->
<section class="shell home-docs" aria-label="Start here">
	<div class="home-docs-head">
		<h2>Start here</h2>
		<p>The full guide moved into the docs, split by topic with live demos inline. Pick a track.</p>
	</div>
	<div class="home-docs-grid">
		<a class="home-docs-card" href="/docs/start/overview">
			<span class="home-docs-kicker">Start</span>
			<span class="home-docs-title">The model, install, adoption</span>
		</a>
		<a class="home-docs-card" href="/docs/regions/client-islands">
			<span class="home-docs-kicker">Islands</span>
			<span class="home-docs-title">Client &amp; server islands, lakes, portable bindings</span>
		</a>
		<a class="home-docs-card" href="/docs/data-state/remote-functions">
			<span class="home-docs-kicker">App</span>
			<span class="home-docs-title">Remote functions, the SPA router, plugin config</span>
		</a>
		<a class="home-docs-card" href="/docs/content/collections">
			<span class="home-docs-kicker">Content</span>
			<span class="home-docs-title">Collections, markdown, site() — outline, shells, search</span>
		</a>
		<a class="home-docs-card" href="/docs/reference/constraints">
			<span class="home-docs-kicker">Reference</span>
			<span class="home-docs-title">Constraints and patterns</span>
		</a>
	</div>
</section>

<SiteFooter meta="ogygia · MIT · named for Calypso's island">
	{#snippet links()}
		<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
		<a href="https://www.npmjs.com/package/ogygia" target="_blank" rel="noreferrer">npm</a>
	{/snippet}
</SiteFooter>

<style>
	.story {
		padding-block: 4rem 1rem;
	}

	.story-intro {
		max-width: 44rem;
		margin: 0 auto 3.5rem;
		text-align: center;
	}

	.story-kicker {
		display: inline-block;
		margin-bottom: 0.75rem;
		font: 600 0.6875rem/1 var(--font-mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.story-intro h2 {
		margin: 0 0 0.6rem;
		font: 600 clamp(1.75rem, 3.5vw, 2.5rem)/1.1 var(--font-display);
		letter-spacing: -0.03em;
		color: var(--text);
	}

	.story-intro p {
		margin: 0;
		color: var(--text-dim);
		line-height: 1.6;
	}

	/* Each beat: a narrative lead-in, then the code+demo card. A quiet rail on the left ties the
	   sequence together so it reads as one story rather than a grid of tiles. Fills the shell like
	   every other section (the App-layer grid, the docs cards) so the section widths stay consistent. */
	.beat {
		position: relative;
		margin: 0 auto;
		padding: 0 0 3.5rem 3.5rem;
	}

	.beat::before {
		content: '';
		position: absolute;
		left: 1.1rem;
		top: 0.4rem;
		bottom: -0.4rem;
		width: 1px;
		background: color-mix(in srgb, var(--accent-line) 45%, var(--line));
	}

	.beat:last-of-type::before {
		display: none;
	}

	.beat-head {
		margin-bottom: 1.25rem;
	}

	.beat-num {
		position: absolute;
		left: 0;
		top: -0.1rem;
		width: 2.2rem;
		height: 2.2rem;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--accent-line) 60%, var(--line));
		background: var(--bg);
		font: 600 0.8rem/1 var(--font-mono);
		color: var(--accent);
	}

	.beat-head h3 {
		margin: 0 0 0.4rem;
		font: 600 1.3rem/1.2 var(--font-display);
		letter-spacing: -0.02em;
		color: var(--text);
	}

	.beat-head p {
		margin: 0;
		max-width: 42rem;
		color: var(--text-dim);
		line-height: 1.6;
	}

	.beat-head code {
		font: 500 0.9em/1 var(--font-mono);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent-deep) 20%, transparent);
		padding: 0.15em 0.4em;
		border-radius: 5px;
	}

	/* The tiles live inside a snippet passed to <ShowcaseCard>, so a scoped selector gets pruned as
	   "unused" from this component's CSS (the element renders in the child's tree). Global-scope the
	   layout so it survives; the class name is unique to this page. */
	/* Grid (not flex): the direct children are island wrappers with min-width:auto, which would keep
	   flex items from shrinking into one row. minmax(0, 1fr) tracks force four equal columns that
	   shrink below content, so all four schedule tiles sit on one horizontal row; 2x2 when cramped. */
	:global(.beat-tiles) {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
		width: 100%;
	}
	@media (max-width: 900px) {
		:global(.beat-tiles) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	/* Compact tiles: stack each tile's value/button vertically so a narrow column still reads well. */
	:global(.beat-tiles .widget) {
		max-width: none;
		padding: 0.9rem 0.7rem;
		text-align: center;
	}
	:global(.beat-tiles .widget-label) {
		margin-bottom: 0.7rem;
	}
	:global(.beat-tiles .widget-row) {
		flex-direction: column;
		align-items: center;
		gap: 0.55rem;
	}

	@media (max-width: 640px) {
		.beat {
			padding-left: 0;
		}
		.beat::before {
			display: none;
		}
		.beat-num {
			position: static;
			margin-bottom: 0.75rem;
		}
	}

	/* App layer: same numbered-beat rhythm as the seven moves (continues 08–11), so the page reads
	   as one linear sequence instead of dropping into a card grid. */
	/* Narrator lines between the story's movements (client → server → shared state). Aligned to the
	   beat column so they read as one voice carrying the page forward. */
	.story-turn {
		margin: 0.25rem auto 2.75rem;
		padding-left: 3.5rem;
		font: 500 1.2rem/1.45 var(--font-display);
		letter-spacing: -0.01em;
		color: var(--text);
	}
	@media (max-width: 640px) {
		.story-turn {
			padding-left: 0;
		}
	}

	.applayer {
		padding-block: 4rem 1rem;
	}
	/* Text-only beats (no demo card) would hug the left under the centred header. A 2-column grid
	   fills the width so the section reads balanced instead of skewed. */
	.applayer-beats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 2.25rem 3rem;
		margin-top: 1rem;
	}
	.applayer .beat {
		padding-bottom: 0;
	}
	.applayer .beat::before {
		display: none;
	}
	@media (max-width: 640px) {
		.applayer-beats {
			grid-template-columns: 1fr;
		}
	}

	.beat-head p a {
		color: var(--accent);
		text-decoration: none;
		font-weight: 500;
		white-space: nowrap;
	}

	.beat-head p a:hover {
		text-decoration: underline;
	}

	/* Content — its own section (pulled out of the islands story), mirrors the app-layer shell. */
	.content-story {
		padding-block: 2rem 1rem;
	}
	.content-head {
		max-width: 46rem;
		margin-bottom: 2rem;
	}
	.content-head h2 {
		margin: 0.5rem 0;
		font: 600 1.75rem/1.15 var(--font-display);
		letter-spacing: -0.03em;
		color: var(--text);
	}
	.content-head p {
		margin: 0;
		color: var(--text-dim);
		line-height: 1.6;
	}
	.content-showcase {
		margin-bottom: 2.5rem;
	}
	.content-lead {
		margin: 0 0 1.1rem;
		color: var(--text-dim);
		font: 400 1rem/1.5 var(--font-body);
	}
	/* Content sources as a numbered timeline — same beats as the seven moves, so it reads down the
	   page with room to breathe instead of a crowded stack of cards. */
	.content-beats {
		margin-top: 0.5rem;
	}
	.content-eyebrow {
		display: block;
		margin-bottom: 0.45rem;
		font: 600 0.6875rem/1 var(--font-mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
	}
	/* The highlighted sample + a learn-more link, sitting under each beat's title. Reuses the global
	   `.demo-code` styling from demo-block.css (loaded by ShowcaseCard on this page). */
	.content-code {
		display: flex;
		flex-direction: column;
		margin: 0;
		border: 1px solid color-mix(in srgb, var(--accent-line) 32%, var(--line));
		border-radius: 14px;
		overflow: hidden;
		background: color-mix(in srgb, var(--bg-raised) 45%, transparent);
	}
	.content-code :global(.demo-code) {
		flex: 1;
		margin: 0;
		padding: 1rem 1.15rem;
		overflow-x: auto;
		font-size: 0.8125rem;
	}
	.content-code-link {
		padding: 0.75rem 1.15rem;
		border-top: 1px solid color-mix(in srgb, var(--accent-line) 22%, var(--line));
		color: var(--accent);
		text-decoration: none;
		font: 500 0.8125rem/1 var(--font-mono);
	}
	.content-code-link:hover {
		background: color-mix(in srgb, var(--accent-deep) 18%, transparent);
	}
	.content-head code {
		font: 500 0.9em/1 var(--font-mono);
		color: var(--accent);
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

	/* Live DocsShell showcase — the flagship. A browser-chrome frame around the real playground,
	   set apart with a tinted full-bleed band so it reads as the centrepiece, not another card. */
	.live-shell {
		margin-block: 3.5rem;
		padding-block: 3.75rem;
		background:
			radial-gradient(
				120% 100% at 50% 0%,
				color-mix(in srgb, var(--accent-deep) 12%, transparent),
				transparent 60%
			),
			var(--bg-sunken);
		border-block: 1px solid var(--line);
	}
	.live-shell-head {
		max-width: 48rem;
		margin-bottom: 2rem;
	}
	.live-shell-head kbd {
		font: 500 0.8125rem/1 var(--font-mono);
		padding: 0.15rem 0.4rem;
		border: 1px solid var(--line-strong);
		border-radius: 5px;
		background: var(--bg-raised);
		color: var(--text);
	}
	/* Break out of the .shell max-width to a wide, centred frame — but not full-bleed. Kept ≥ ~1080px
	   so the iframe still renders DocsShell's DESKTOP layout (sidebar visible), not the mobile one. */
	.live-frame {
		width: min(86vw, 1180px);
		margin-inline: auto;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		overflow: clip;
		background: var(--bg-raised);
		box-shadow: var(--shadow-panel);
	}
	.live-frame-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.9rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
	}
	.live-frame-dots {
		display: inline-flex;
		gap: 0.4rem;
	}
	.live-frame-dots i {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 50%;
		background: var(--line-strong);
	}
	.live-frame-url {
		flex: 1;
		min-width: 0;
		font: 400 0.8125rem/1.3 var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.live-frame-open {
		flex-shrink: 0;
		margin-left: auto;
		font: 500 0.8125rem/1 var(--font-mono);
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}
	.live-frame-open:hover {
		text-decoration: underline;
	}
	.live-frame-view {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 10;
		border: 0;
		background: var(--bg);
	}
	@media (max-width: 640px) {
		.live-frame-view {
			aspect-ratio: auto;
			height: 70vh;
			min-height: 460px;
		}
		/* Drop the decorative dots so the title + "Open in full" fit on one line. */
		.live-frame-dots {
			display: none;
		}
	}

	/* Global-scoped for the same reason as .beat-tiles: this container renders inside a snippet
	   handed to <ShowcaseCard>, so a component-scoped rule is pruned as "unused". */
	:global(.showcase-pair) {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		width: 100%;
	}

	@media (max-width: 520px) {
		:global(.showcase-pair) {
			grid-template-columns: 1fr;
		}
	}
</style>
