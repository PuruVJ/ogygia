<script lang="ts">
	import Contours from '$lib/Contours.svelte';
	import { Region } from 'ogygia';
	import {
		heroCode, heroCodeHtml, loadCode, visibleCode, lakeCode, serverCode, fragmentCode,
		livePartialCode, sharedObjectCode, contentCollectionCode, contentMarkdownCode,
		contentJsonCode, contentCustomCode, defineSiteCode
	} from '$lib/code/snippets';
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
				No Kit client bootstrap. The shared runtime is a custom element plus an optional router —
				<strong>lightweight</strong>, and JS ships only for the components you mark. Mark a
				component with an import attribute and it wakes on a schedule; everything else stays
				server HTML. Server islands, lakes, held regions, and prerendering are all the same idea,
				shaped differently.
			</p>
			<div class="btn-row">
				<a class="btn btn--primary" href="/docs/start/install">Adoption</a>
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

<Features />

<section class="shell story" aria-labelledby="story">
	<div class="story-intro">
		<span class="story-kicker">The whole idea, in seven moves</span>
		<h2 id="story">A page is HTML until you say otherwise</h2>
		<p>
			Every demo below is a real island on this page. Read top to bottom — each move adds exactly one
			idea, and by the end you have seen the whole library.
		</p>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">01</span>
			<h3>One attribute wakes a component</h3>
			<p>
				The page ships as server HTML with nothing to hydrate. Add <code>wake: 'load'</code> to an
				import and that component — and only that one — becomes interactive. Flip JS off: the island
				stops, the page stays.
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
				Swap the schedule: <code>load</code>, <code>idle</code>, <code>visible</code>, or a media
				query. Each island's JS arrives on its own trigger, so a mostly-static page stays cheap.
			</p>
		</div>
		<ShowcaseCard
			title="Schedules"
			tag="idle · visible · media"
			marker="each wakes on its own trigger"
			code={visibleCode}
			stack
		>
			{#snippet demo()}
				<div class="beat-tiles">
					<IdleClock />
					<VisibleWidget />
					<MediaWidget />
				</div>
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">03</span>
			<h3>Freeze what never moves — zero JS</h3>
			<p>
				A heavy, static chunk inside an island is a <strong>lake</strong>: <code>wake: 'none'</code>.
				It renders on the server and its markup never enters the client bundle.
			</p>
		</div>
		<ShowcaseCard title="Lake" tag="wake: 'none'" marker="frozen · 0 KB JS" code={lakeCode}>
			{#snippet demo()}
				<FrozenCounter start={42} note="SSR HTML, no client JS" />
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">04</span>
			<h3>Hand a hole to the server</h3>
			<p>
				<code>render: 'deferred'</code> makes a server island: per-request HTML, personalized, with
				no client bundle at all. It fetches its own markup after the shell paints.
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
				A <strong>held region</strong> goes further: the server picks <em>which</em> component
				renders and hands back signed HTML. The client paints it without ever importing the options.
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
				<code>query.live</code> yields a rendered region every tick. The server pushes the HTML down
				the channel and the client <strong>morphs</strong> it in place — no client data code, no
				per-tick fetch.
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

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">07</span>
			<h3>Share one object across islands</h3>
			<p>
				Two separate island bundles, one live object passed as a prop. The add button writes it, the
				counter reads it — no store, no event bus. That is the wire contract doing the wiring.
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
		<span class="story-kicker">Content is an island too</span>
		<h2 id="content-story">Your content is a collection</h2>
		<p>
			Define a collection once with <code>content()</code> — markdown, JSON, or a CMS behind a few
			lines. Query it over the wire like any remote function and the bodies never ship; the entry you
			render is a region, so a page's content wakes on the same schedule as everything else. These
			very docs run on it.
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

<section class="shell content-story" aria-labelledby="site-story">
	<div class="content-head">
		<span class="story-kicker">And then the collection becomes a site</span>
		<h2 id="site-story">A docs site is one bag of options</h2>
		<p>
			This is where the story has been heading. Hand <code>defineSite()</code> a collection and it
			mints the <em>brains</em>: the nav tree built from your filenames, prev/next that follows real
			links, full-text search, <code>sitemap.xml</code> and <code>llms.txt</code>, and a link audit
			that fails the build before a reader ever sees a dead end. Mount a shell, and you have what
			you are looking at — <strong>this site is the demo</strong>.
		</p>
	</div>

	<div class="content-showcase">
		<ShowcaseCard
			title="The whole site"
			tag="defineSite()"
			marker="these docs, verbatim"
			code={defineSiteCode}
			stack
		>
			{#snippet demo()}
				<ContentPeek />
			{/snippet}
		</ShowcaseCard>
	</div>

	<div class="content-beats">
		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">01</span>
				<span class="content-eyebrow">The arrangement</span>
				<h3>Filenames become the nav</h3>
				<p>
					<code>NN-</code> prefixes order, <code>+meta.json</code> names sections, and every
					misplaced page is a named build error — never a silent gap.
					<a href="/docs/site/outline">Outline →</a>
				</p>
			</div>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">02</span>
				<span class="content-eyebrow">The chrome</span>
				<h3>Shells you can keep or shed</h3>
				<p>
					<code>DocsShell</code> and <code>BlogShell</code> are compositions of public bricks —
					replace any region with a snippet, or drop to <code>Frame</code> and bring your own.
					<a href="/docs/site/shell">Shells →</a>
				</p>
			</div>
		</div>

		<div class="beat">
			<div class="beat-head">
				<span class="beat-num">03</span>
				<span class="content-eyebrow">The audience you don't see</span>
				<h3>Search, sitemap, llms.txt — emitted</h3>
				<p>
					An on-device search worker over a prerendered index, and machine-facing serializations
					that can never drift — they are views of the same tree.
					<a href="/docs/site/search">Search →</a>
				</p>
			</div>
		</div>
	</div>

	<p class="content-lead">One command scaffolds all of it: <code>npx ogygia site init</code>.</p>
</section>

<section class="shell applayer" aria-labelledby="applayer">
	<div class="story-intro">
		<span class="story-kicker">Around the islands</span>
		<h2 id="applayer">And a whole app layer</h2>
		<p>
			The islands are the primitive. Around them, ogygia makes the page itself fast — prerender the
			shell, batch the holes, and navigate like an app, all with no extra client code.
		</p>
	</div>

	<div class="beat">
		<div class="beat-head">
			<span class="beat-num">01</span>
			<h3>Bake the shell, fill the holes</h3>
			<p>
				Partial prerendering serves a static file from the CDN with dynamic server islands fetched
				per visitor — a live reload demo shows one page telling two times.
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
			<span class="home-docs-title">RF-native collections, markdown, live sources</span>
		</a>
		<a class="home-docs-card" href="/docs/site/site">
			<span class="home-docs-kicker">Site</span>
			<span class="home-docs-title">defineSite() — outline, shells, search, emissions</span>
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

	.beat-tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.75rem;
		width: 100%;
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
	.applayer {
		padding-block: 4rem 1rem;
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
