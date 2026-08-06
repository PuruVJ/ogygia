<script lang="ts">
	import Contours from '$lib/Contours.svelte';
	import Logo from '$lib/Logo.svelte';
	import SiteNav from '$lib/SiteNav.svelte' with { hydrate: '(max-width: 767px)' };
	import Toc from '$lib/Toc.svelte' with { hydrate: 'load' };
	import HeroDemo from '$lib/demos/HeroDemo.svelte' with { hydrate: 'load' };
	import LoadDemo from '$lib/demos/LoadDemo.svelte' with { hydrate: 'load' };
	import IdleDemo from '$lib/demos/IdleDemo.svelte' with { hydrate: 'idle' };
	import VisibleDemo from '$lib/demos/VisibleDemo.svelte' with { hydrate: 'visible' };
	import MediaDemo from '$lib/demos/MediaDemo.svelte' with { hydrate: '(max-width: 600px)' };
	import ServerDemo from '$lib/demos/ServerDemo.svelte';
	import GreetingLoad from '$lib/demos/ServerGreeting.svelte' with { defer: 'load' };
	import GreetingIdle from '$lib/demos/ServerGreeting.svelte' with { defer: 'idle' };
	import GreetingVisible from '$lib/demos/ServerGreeting.svelte' with { defer: 'visible' };
	import GreetingMedia from '$lib/demos/ServerGreeting.svelte' with { defer: '(max-width: 600px)' };
	// Presentational only — Shiki HTML is baked at build via snippets.remote.ts (never ships Shiki).
	import CodeBlock from '$lib/CodeBlock.svelte';
	import PageHead from '$lib/PageHead.svelte';
	import Features from '$lib/Features.svelte';

	let { data }: { data: import('./$types').PageData } = $props();

	const docsLinks = [
		{ href: '/playground', label: 'Playground', outbound: true }
	];
</script>

<PageHead
	description="SSR islands for SvelteKit. No Kit client bootstrap — a ~4.5 KB runtime (custom element + router), and JS only for the components you mark."
/>

<div id="top"></div>

<SiteNav brandHref="#top" links={docsLinks} github />

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
				about <strong>4.5&nbsp;KB</strong> min+brotli. Mark components with an import attribute and
				they become interactive on a schedule; everything else stays server HTML.
			</p>
			<div class="btn-row">
				<a class="btn btn--primary" href="#install">Get started</a>
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

<div class="toc-fixed" aria-hidden="true">
	<Toc />
</div>

<main class="shell docs-main">
	<section id="what">
		<h2>What it does</h2>
		<div class="what-grid">
			<div class="prose">
				<p>
					SvelteKit’s default is to run client JS for the whole route. That is a strong fit for
					app-like pages. ogygia is for when you want the opposite authoring default: keep the
					page as server HTML, and opt individual components into JS.
				</p>
				<p>
					Set <code>csr = false</code> so there is no Kit client bootstrap. What still loads is
					ogygia’s own runtime: a custom element that wakes islands, plus an optional SPA router —
					about <strong>4.5&nbsp;KB</strong> min+brotli together. Mark a component import with
					<code>hydrate</code>, <code>defer</code>, or a preset and it becomes an
					<strong>island</strong>: serialized props, its own client chunk, and a schedule for when
					JS arrives. Everything else stays server HTML.
				</p>
				<p>
					The library does not patch Kit. It is a Vite plugin plus that small runtime and a server
					handle. Runtime deps are <code>devalue</code>, <code>magic-string</code>, and
					<code>estree-walker</code>. Peers are Svelte 5.40+, Kit 2.70+, and Vite 5 through 8.
					Kit is deep-imported for a few internals (remote wire codec, client remote entry), so
					treat the Kit range as tested rather than a soft semver promise.
				</p>
			</div>
			<div class="archipelago" aria-hidden="true">
				<span class="archipelago-label">route.html · SSR + ~4.5 KB runtime</span>
				<div class="archipelago-shell">
					<div class="archipelago-island">Counter.svelte</div>
					<div class="archipelago-island">Search.svelte</div>
				</div>
			</div>
		</div>
	</section>

	<section id="map">
		<h2>The words</h2>
		<div class="map-scroll">
			<table class="map-table">
				<thead>
					<tr>
						<th scope="col">Word</th>
						<th scope="col">Meaning</th>
						<th scope="col">You write</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Page</td>
						<td>SSR HTML. No Kit client — tiny ogygia runtime (~4.5&nbsp;KB).</td>
						<td><code>csr = false</code></td>
					</tr>
					<tr>
						<td>Island</td>
						<td>Becomes interactive</td>
						<td><code>hydrate: 'load'</code> (or idle/visible/media)</td>
					</tr>
					<tr>
						<td>Lake</td>
						<td>Static HTML inside an island</td>
						<td><code>hydrate: 'none'</code></td>
					</tr>
					<tr>
						<td>Server island</td>
						<td>HTML loaded later</td>
						<td><code>defer: 'load'</code> (or idle/visible/media)</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="map-nest">
			Nesting: island inside island shares the parent's JS. Lake freezes a subtree. Island inside a
			lake becomes interactive again.
		</p>
	</section>

	<section id="install">
		<h2>Install</h2>
		<div class="prose">
			<p>
				Install the package, register the Vite plugin <em>before</em>
				<code>sveltekit()</code>, add the server handle, and set <code>csr = false</code> on
				routes that should skip the Kit client bootstrap.
			</p>
		</div>
		<div class="install-strip">
			<div class="install-inner">
				<pre class="install-cmd">pnpm add ogygia</pre>
				<div class="install-aside">
					<pre><code>plugins: [ogygia(), sveltekit()]</code></pre>
					<p class="caption">order matters</p>
				</div>
			</div>
		</div>

		<h3 class="doc-subhead">vite.config.ts</h3>
		<div class="prose">
			<p>
				<code>ogygia()</code> must run before <code>sveltekit()</code> (it also sets
				<code>enforce: 'pre'</code>). For every option, see
				<a href="#plugin">Plugin config</a>.
			</p>
		</div>
		<CodeBlock html={data.viteConfigHtml} />

		<h3 class="doc-subhead">Layout + hooks</h3>
		<div class="prose">
			<p>
				<code>csr = false</code> is what removes Kit's client runtime from the page. Kit skips
				its client build entirely when <em>every</em> route is <code>csr = false</code>. Islands
				still need a client build (runtime + code-split chunks), so keep at least one normal Kit
				route, or let ogygia run its standalone client build (both paths are supported).
			</p>
			<p>
				<code>ogygiaHandle()</code> serves the signed island endpoint used by
				<code>defer</code>. Compose it with <code>sequence()</code> if you already have handles.
				Override the path with <code>ogygiaHandle(&#123; endpoint: '/my-islands' &#125;)</code>
				if you do not want the default clash-safe emoji route.
			</p>
		</div>
		<CodeBlock html={data.layoutAndHooksHtml} />
	</section>

	<section id="plugin">
		<div class="section-header">
			<h2>Plugin config</h2>
			<p class="section-lede">
				Everything <code>ogygia()</code> accepts in <code>vite.config.ts</code> — defaults,
				presets, rate limits, and signing.
			</p>
		</div>
		<div class="prose">
			<p>
				Import from <code>ogygia/vite</code>. Put the plugin before <code>sveltekit()</code>.
				Inline import attributes only accept <code>hydrate</code>, <code>defer</code>, or
				<code>preset</code> — put <code>margin</code>, <code>remount</code>, and shared strategy
				bundles in the plugin options below.
			</p>
		</div>
		<CodeBlock html={data.pluginConfigHtml} />

		<div class="map-scroll">
			<table class="map-table">
				<thead>
					<tr>
						<th scope="col">Option</th>
						<th scope="col">Default</th>
						<th scope="col">What it does</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td><code>visible.margin</code></td>
						<td><em>none</em></td>
						<td>Default <code>rootMargin</code> for <code>hydrate</code>/<code>defer: 'visible'</code></td>
					</tr>
					<tr>
						<td><code>presets</code></td>
						<td><code>&#123;&#125;</code></td>
						<td>Named strategy bundles referenced with <code>preset: 'name'</code></td>
					</tr>
					<tr>
						<td><code>rateLimit</code></td>
						<td><code>&#123; max: 60, windowMs: 60_000 &#125;</code></td>
						<td>Per-IP budget for the signed island endpoint; <code>false</code> disables</td>
					</tr>
					<tr>
						<td><code>sessionCookie</code></td>
						<td><code>false</code></td>
						<td>Cookie name sealed into the region MAC (opt-in)</td>
					</tr>
				</tbody>
			</table>
		</div>

		<h3 id="plugin-visible" class="doc-subhead">visible</h3>
		<div class="prose">
			<p>
				<code>visible: &#123; margin?: string &#125;</code> sets the default
				<code>IntersectionObserver</code> <code>rootMargin</code> for every island that uses
				<code>hydrate: 'visible'</code> or <code>defer: 'visible'</code> without its own margin
				(via a preset). Same CSS margin syntax the observer accepts — e.g.
				<code>'200px'</code> or <code>'0px 0px 100px'</code>.
			</p>
			<p>
				Per-island overrides belong in a preset (<code>margin</code> on that named config), not
				on the import attribute.
			</p>
		</div>

		<h3 id="plugin-presets" class="doc-subhead">presets</h3>
		<div class="prose">
			<p>
				<code>presets</code> is a map of names to strategy objects. Reference one from an import:
			</p>
			<p>
				<code>import Chart from '$lib/Chart.svelte' with &#123; preset: 'chart' &#125;;</code>
			</p>
			<p>Each preset may include:</p>
			<ul>
				<li>
					<code>hydrate</code> — <code>'load'</code> | <code>'idle'</code> |
					<code>'visible'</code> | a media-query string | <code>'none'</code> (lake)
				</li>
				<li>
					<code>defer</code> — same schedule values as hydrate (server island; mutually exclusive
					with <code>hydrate</code> on that import)
				</li>
				<li>
					<code>margin</code> — rootMargin for this preset when the strategy is
					<code>'visible'</code>
				</li>
				<li>
					<code>remount</code> — lake-only (<code>hydrate: 'none'</code>). Strategies and
					<code>swr</code> constraints are under <a href="#remount">Remount</a>.
				</li>
			</ul>
			<p>
				Unknown preset names, unknown keys, and mixing <code>preset</code> with inline
				<code>hydrate</code>/<code>defer</code> are build errors.
			</p>
		</div>

		<h3 id="plugin-rate" class="doc-subhead">rateLimit</h3>
		<div class="prose">
			<p>
				Protects the signed deferred-region / lake-remount endpoint served by
				<code>ogygiaHandle()</code>. Default is
				<code>&#123; max: 60, windowMs: 60_000 &#125;</code> — sixty requests per IP per minute.
				Pass <code>rateLimit: false</code> to disable (or <code>max: 0</code>). Values are baked
				into the server bundle at build time.
			</p>
		</div>

		<h3 id="plugin-session" class="doc-subhead">sessionCookie</h3>
		<div class="prose">
			<p>
				Opt-in. Pass a cookie name (string) to seal that cookie’s value into the region
				capability MAC. Harvested defer/remount URLs then fail verification without the same
				cookie. Empty or missing cookies stay unbound (same as the default
				<code>false</code>). Useful when personalized HTML must not be replayable from a stolen
				URL alone.
			</p>
		</div>

		<h3 id="plugin-secret" class="doc-subhead">OGYGIA_SECRET</h3>
		<div class="prose">
			<p>
				Not a plugin argument — an environment variable the plugin reads at config time
				(<code>.env</code> / <code>.env.local</code> via Vite’s <code>loadEnv</code>, or a shell
				export).
			</p>
			<ul>
				<li>
					<strong>Signing key</strong> for region capability URLs (defer + lake
					<code>remount: 'swr'</code>). When unset, each build gets a fresh random secret baked
					into the <em>server</em> bundle only. Set a stable
					<code>OGYGIA_SECRET</code> so rolling deploys and long-lived cached HTML keep
					verifying.
				</li>
				<li>
					<strong>Region id salt</strong> — when set, island ids are not offline-computable from
					source paths alone.
				</li>
			</ul>
			<p>
				Related server option (not on the Vite plugin):
				<code>ogygiaHandle(&#123; endpoint: '/my-islands' &#125;)</code> changes the path the handle
				serves; see <a href="#install">Install</a>.
			</p>
		</div>
	</section>

	<section id="authoring">
		<h2>Authoring</h2>
		<div class="prose">
			<p>
				Mark an import with exactly one of <code>hydrate</code>, <code>defer</code>, or
				<code>preset</code>. Import-attribute values must be string literals (ES spec). Every
				usage of that marked binding is an island.
			</p>
		</div>
		<CodeBlock html={data.authoringImportsHtml} />
		<div class="prose">
			<p>
				Props cross the boundary through <strong>devalue</strong>. <code>Date</code>,
				<code>Map</code>, <code>Set</code>, <code>BigInt</code>, and nested plain objects survive.
				Functions do not. Free variables from outer scope that the island closes over are
				captured automatically and passed as props. Children and snippets work; a snippet defined
				outside an island but used inside is a build error, except the reserved server-island
				<code>ogygiaFallback</code>.
			</p>
			<p>
				You cannot put option keys on the import itself. Margins and similar tuning belong in
				plugin config or a preset. Unknown presets, unknown keys, mixing
				<code>preset</code> with another key, and <code>defer</code> + <code>hydrate</code>
				together are build errors (the last one is roadmap).
			</p>
			<p>
				Each island is an independent Svelte app. Islands do not share reactive state. If two
				islands need the same data, pass it as props from the server page, or fetch inside each
				island (remote functions work).
			</p>
			<p>
				The same module can be imported twice with different strategies. Per-use bindings are
				how you get JS for one counter on load and another instance of the same component on
				visible.
			</p>
		</div>

		<h3 class="doc-subhead">Nesting</h3>
		<div class="prose">
			<p>
				An island may import another island. The inner one sits inside an already-interactive
				parent, so it shares the parent's JS and its own strategy is ignored (a dev-only warning
				names it). An island inside a <em>lake</em> is the opposite: the lake froze its subtree,
				so the inner island gets JS on its own schedule again.
			</p>
			<p>
				You can alternate all the way down: page → island → lake → island. A server island nested
				inside an island renders inline with its parent (its <code>defer</code> is ignored there;
				DESIGN.md records the roadmap semantics).
			</p>
			<p>
				Editor note: the <code>with &#123; … &#125;</code> syntax needs your
				<code>tsconfig.json</code> to extend Kit's generated one (the default template already
				does). TypeScript 5.3+ accepts arbitrary import-attribute keys under
				<code>module: "esnext"</code>, and svelte-check 4.7+ parses it cleanly.
			</p>
		</div>

		<h3 class="doc-subhead" id="boundary">Annotation boundary</h3>
		<div class="prose">
			<p>
				<code>&lt;OgygiaBoundary&gt;</code> is an optional public wrapper that renders its
				children and nothing else — no extra DOM, no nested-island context, no
				<code>hydrate</code> / <code>render</code> effect. Use it only when you want to mark an
				island usage in source for humans (or for a future hook). It is not
				<code>&lt;svelte:boundary&gt;</code>, and it is not the internal lake context reset.
			</p>
		</div>
		<CodeBlock html={data.ogygiaBoundaryHtml} />
	</section>

	<section id="strategies">
		<span class="eyebrow">Hydration</span>
		<div class="section-header">
			<h2>Strategies</h2>
			<p class="section-lede">
				Pick when JavaScript arrives. Same schedule words —
				<code>load</code> / <code>idle</code> / <code>visible</code> / a media query — control
				when HTML arrives for <a href="#server-islands">server islands</a> via
				<code>defer</code>. The blocks below are real islands on this page.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy" id="client-load">
				<h3><code>hydrate: 'load'</code></h3>
				<div class="prose">
					<p>
						Default for critical UI. The island gets JS as soon as the
						<code>ogygia-region</code> custom element connects (after DOM ready). The island's
						module is part of the critical client graph for that page.
					</p>
					<p>
						Use it for above-the-fold controls the page cannot function without: primary nav,
						search, the first form. Avoid sprinkling load across the whole page; every load
						island competes with LCP and main-thread work.
					</p>
				</div>
				<LoadDemo codeHtml={data.loadCode} />
			</div>

			<div class="strategy" id="client-idle">
				<h3><code>hydrate: 'idle'</code></h3>
				<div class="prose">
					<p>
						Defers JS until the browser is idle via
						<code>requestIdleCallback</code>, with a roughly two-second timeout and a short
						<code>setTimeout</code> fallback where idle callbacks are missing. The HTML is
						already on the page; only the listeners and reactive runtime wait.
					</p>
					<p>
						Use it for secondary chrome: help panels, non-critical toggles, anything that
						should not delay first interaction with load islands. If the tab stays busy, the
						timeout still brings the island up so it cannot stall forever.
					</p>
				</div>
				<IdleDemo codeHtml={data.idleCode} />
			</div>

			<div class="strategy" id="client-visible">
				<h3><code>hydrate: 'visible'</code></h3>
				<div class="prose">
					<p>
						JS is gated on <code>IntersectionObserver</code>. Until the island enters
						(or approaches) the viewport, it remains SSR HTML. That is the usual choice for
						below-the-fold charts, comment trees, related-content carousels, and heavy embeds.
					</p>
					<p>
						Configure a default <code>rootMargin</code> on the plugin
						(<code>visible.margin</code>) or per preset so islands can start loading slightly
						before they scroll on screen. A margin like <code>'200px'</code> is a common
						pre-warm. Without a margin, JS loads at the moment of intersection.
					</p>
				</div>
				<div class="scroll-hint">
					Scroll until the visible island below intersects the viewport.
				</div>
				<VisibleDemo codeHtml={data.visibleCode} />
			</div>

			<div class="strategy" id="client-media">
				<h3><code>hydrate: '(max-width: 600px)'</code></h3>
				<div class="prose">
					<p>
						Any media-query string is a valid strategy. The runtime calls
						<code>matchMedia</code>: if the query already matches, the island gets JS
						immediately; otherwise it waits for a change event. This is how you ship
						mobile-only drawers or desktop-only inspectors without paying for their JS on the
						other viewport.
					</p>
					<p>
						The demo island below uses <code>(max-width: 600px)</code>. On a wide laptop it may
						stay static until you narrow the window. That is the strategy working as designed,
						not a broken preview.
					</p>
				</div>
				<MediaDemo codeHtml={data.mediaCode} />
			</div>
		</div>
	</section>

	<section id="server-islands">
		<span class="eyebrow">defer</span>
		<div class="section-header">
			<h2>Server islands</h2>
			<p class="section-lede">
				<code>defer</code> moves rendering off the page SSR and onto a signed fetch. Same
				schedules as <a href="#strategies">hydrate</a> — but for when HTML arrives, not when JS
				loads. The component’s JS never ships.
			</p>
		</div>
		<div class="prose">
			<p>
				At page render time, only the reserved <code>ogygiaFallback</code> snippet is written into
				the document as a placeholder. The component itself is not executed yet. Props are
				serialized with devalue and HMAC-signed so the endpoint can reject tampering. The fetch
				hits <code>ogygiaHandle()</code> on the same origin, so cookies flow and the deferred
				render sees a real request context. Remote functions and <code>await</code> work there.
				CSS is still collected through the page import graph.
			</p>
			<p>
				Signing bakes a per-build HMAC key into the server bundle by default. Set
				<code>OGYGIA_SECRET</code> when rolling deploys or cached HTML must keep verifying. Default
				endpoint: <code>/🏝️ogygia🏝️</code>. Override with
				<code>ogygiaHandle(&#123; endpoint &#125;)</code>. The old boolean
				<code>defer: 'true'</code> is a build error pointing at <code>'load'</code>. v1 does not
				load JS after the HTML swap — pairing <code>defer</code> with hydrate is roadmap.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy" id="server-load">
				<h3><code>defer: 'load'</code></h3>
				<div class="prose">
					<p>
						Fetches as soon as the region connects. Only this schedule emits a
						<code>&lt;link rel="preload" as="fetch"&gt;</code> hint (skipped when prerendering);
						the runtime reuses that preload so there is one server render.
					</p>
					<p>
						Use it for personalized chrome that should fill in immediately: greetings, account
						chips, anything the first viewport expects once the shell is up.
					</p>
				</div>
				<ServerDemo title="defer: 'load' · ServerGreeting.svelte" codeHtml={data.serverCode}>
					{#snippet live()}
						<GreetingLoad salutation="Aloha">
							{#snippet ogygiaFallback()}
								<div class="widget widget--greeting">
									<strong>Fetching island…</strong>
									<p class="widget-meta">Fallback while the server renders</p>
								</div>
							{/snippet}
						</GreetingLoad>
					{/snippet}
				</ServerDemo>
			</div>

			<div class="strategy" id="server-idle">
				<h3><code>defer: 'idle'</code></h3>
				<div class="prose">
					<p>
						Waits for <code>requestIdleCallback</code> (same ~2s timeout / short
						<code>setTimeout</code> fallback as hydrate idle) before fetching. No preload hint —
						the server stays quiet until the browser has spare time.
					</p>
					<p>
						Use it for secondary personalized fragments that should not compete with LCP or
						critical load islands.
					</p>
				</div>
				<ServerDemo title="defer: 'idle' · ServerGreeting.svelte" codeHtml={data.serverIdleCode}>
					{#snippet live()}
						<GreetingIdle salutation="Idle">
							{#snippet ogygiaFallback()}
								<div class="widget widget--greeting">
									<strong>Waiting for idle…</strong>
									<p class="widget-meta">Fallback until requestIdleCallback</p>
								</div>
							{/snippet}
						</GreetingIdle>
					{/snippet}
				</ServerDemo>
			</div>

			<div class="strategy" id="server-visible">
				<h3><code>defer: 'visible'</code></h3>
				<div class="prose">
					<p>
						Holds the fetch until the placeholder intersects the viewport
						(<code>IntersectionObserver</code>). The server does no work for content nobody
						reached. Same <code>visible.margin</code> / preset <code>margin</code> as hydrate.
					</p>
					<p>
						Use it for below-the-fold personalized blocks, related content, or heavy server
						fragments on long pages.
					</p>
				</div>
				<div class="scroll-hint">
					Scroll until the deferred hole below intersects the viewport.
				</div>
				<ServerDemo
					title="defer: 'visible' · ServerGreeting.svelte"
					codeHtml={data.serverVisibleCode}
				>
					{#snippet live()}
						<GreetingVisible salutation="Visible">
							{#snippet ogygiaFallback()}
								<div class="widget widget--greeting">
									<strong>Scroll to fetch…</strong>
									<p class="widget-meta">Fallback until visible</p>
								</div>
							{/snippet}
						</GreetingVisible>
					{/snippet}
				</ServerDemo>
			</div>

			<div class="strategy" id="server-media">
				<h3><code>defer: '(max-width: 600px)'</code></h3>
				<div class="prose">
					<p>
						Any media-query string is a valid schedule. The runtime uses
						<code>matchMedia</code>: fetch immediately if it already matches, otherwise wait for
						a change. No preload hint.
					</p>
					<p>
						The demo below uses <code>(max-width: 600px)</code>. On a wide laptop it may stay on
						the fallback until you narrow the window — same idea as hydrate media, for HTML
						instead of JS.
					</p>
				</div>
				<ServerDemo
					title="defer: '(max-width: 600px)' · ServerGreeting.svelte"
					codeHtml={data.serverMediaCode}
				>
					{#snippet live()}
						<GreetingMedia salutation="Matched">
							{#snippet ogygiaFallback()}
								<div class="widget widget--greeting">
									<strong>Waiting for media…</strong>
									<p class="widget-meta">Fallback until the query matches</p>
								</div>
							{/snippet}
						</GreetingMedia>
					{/snippet}
				</ServerDemo>
			</div>
		</div>
	</section>

	<section id="lakes">
		<div class="section-header">
			<h2>Lakes</h2>
			<p class="section-lede">
				A lake freezes HTML inside an island. No JS ships for that subtree.
			</p>
		</div>
		<div class="prose">
			<p>
				Import a component <code>with &#123; hydrate: 'none' &#125;</code> and use it inside an
				interactive island: that subtree <strong>freezes</strong>. It server-renders inline like
				everything else, but its component code ships in <em>no</em> client chunk — the island's
				browser module swaps the import for a placeholder — and the runtime lifts the lake's SSR
				DOM out before the parent becomes interactive, then puts it back untouched. The parent
				island is fully interactive around static HTML.
			</p>
			<p>
				Lake content is static after render. Props changes after the page render do nothing;
				event handlers inside are inert. When the parent destroys and re-creates the frozen spot
				(usually an <code>&#123;#if&#125;</code>), see <a href="#remount">Remount</a>.
			</p>
			<p>
				Where it pays: a heavy rendered markdown blob inside an interactive editor, a big SVG
				legend inside a live chart, a long syntax-highlighted code listing inside a collapsible
				panel. All the markup, none of the JavaScript. An island authored <em>inside</em> a lake
				becomes interactive again on its own schedule.
			</p>
			<p>
				A <code>hydrate: 'none'</code> import used on the plain page is a no-op (the page already
				has no JS) and dev-warns so you notice. The value is the string
				<code>'none'</code> — <code>'false'</code> is a build error that points you at it.
			</p>
		</div>

		<h3 id="remount" class="doc-subhead">Remount</h3>
		<div class="prose">
			<p>
				<code>remount</code> controls what happens when a lake’s custom element is re-created
				after the parent island tore it down — typically
				<code>&#123;#if show&#125;&lt;Lake /&gt;&#123;/if&#125;</code>. It only applies to
				<code>hydrate: 'none'</code>, and it is configured on a <strong>preset</strong> (not as
				an inline import attribute).
			</p>
		</div>
		<div class="map-scroll">
			<table class="map-table">
				<thead>
					<tr>
						<th scope="col">Value</th>
						<th scope="col">On remount</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td><code>'cache'</code></td>
						<td>Default. Restore the SSR DOM the runtime cached on first paint.</td>
					</tr>
					<tr>
						<td><code>'empty'</code></td>
						<td>Leave the spot blank (no restored HTML).</td>
					</tr>
					<tr>
						<td><code>'swr'</code></td>
						<td>
							Paint the cache immediately, then revalidate from a signed endpoint (stale-while-revalidate).
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="prose">
			<p>
				String form: <code>remount: 'cache' | 'empty' | 'swr'</code>. Object form (needed for
				scheduling <code>swr</code>):
			</p>
			<p>
				<code>remount: &#123; strategy: 'cache' | 'empty' | 'swr', when?: string &#125;</code>
			</p>
			<p>
				<code>when</code> is only valid with <code>strategy: 'swr'</code>. Same schedules as
				hydrate / defer: <code>'load'</code> (default for swr), <code>'idle'</code>,
				<code>'visible'</code>, or a media-query string. For
				<code>when: 'visible'</code>, a preset <code>margin</code> (or the plugin
				<code>visible.margin</code>) is the IntersectionObserver rootMargin.
			</p>
			<p>
				<code>swr</code> reuses the same signed region endpoint as server islands
				(<code>ogygiaHandle()</code>, <code>rateLimit</code>, <code>sessionCookie</code>,
				<code>OGYGIA_SECRET</code>). The capability URL is minted at SSR only (no client remint;
				same ~24h window). Islands nested inside the lake wait for the revalidate swap before
				they get JS, so they hydrate once against the fresh HTML.
			</p>
			<p>
				<code>swr</code> constraints (build errors otherwise): the lake usage must be a leaf —
				no children / snippets — and only plain serializable attributes or spreads (no
				<code>bind:</code>, no event/callback props). The component path must resolve
				(<code>$lib/…</code> or relative) so the endpoint can re-render it. If props cannot cross
				the wire at mint time, the endpoint is omitted and remount behaves like
				<code>'cache'</code>.
			</p>
		</div>
		<CodeBlock html={data.remountConfigHtml} />
	</section>

	<section id="data">
		<div class="section-header">
			<h2>Data, forms, remote functions</h2>
			<p class="section-lede">
				Server data flows in as props. Interactivity talks back through Kit's own remote
				functions — real Kit code, not an imitation.
			</p>
		</div>
		<div class="prose">
			<p>
				The boring path first: <code>+page.server.ts</code> loads run on every request, the page
				renders their data, and islands receive whatever you pass them as devalue-serialized
				props. Classic <strong>form actions</strong> work untouched on <code>csr = false</code>
				pages — a plain <code>&lt;form method="POST"&gt;</code> submits natively with zero JS, the
				SPA router does not intercept form posts, and post-redirect-get lands where it should.
				This is the most robust interactivity on the page and it costs nothing.
			</p>
			<p>
				Inside islands, every <code>.remote.ts</code> primitive works, in both build modes. The
				client side reuses Kit's own primitives and wire codec (deep-imported, not patched), plus
				your app's universal <code>transport</code> hook — so custom types and
				<code>File</code> arguments round-trip exactly. <code>query</code> resolves during SSR
				in-process, and its result is <strong>seeded</strong> into the client cache so the island
				adopts what is already on screen instead of re-fetching (no flash of pending).
				<code>query.live</code> streams over SSE with a reactive <code>.current</code>.
				<code>query.batch</code> collapses simultaneous calls into one request.
				<code>command</code> mutates and pairs with <code>.refresh()</code>.
				<code>form()</code> gives you the spreadable form object, field API, validation issues,
				pending state, and a no-JS fallback post. <code>prerender()</code> bakes data at build
				time — on a page that is not itself prerendered, declare it
				<code>&#123; dynamic: true &#125;</code> or the runtime request has no static response to
				hit.
			</p>
			<p>
				Two operational notes. <code>command</code> and <code>form</code> POSTs pass through
				Kit's CSRF check, so production needs a correct <code>ORIGIN</code> environment variable
				(adapter-node and friends) — a 403 on commands in prod is almost always this. And with
				<code>prerender = true</code> on a page: normal islands get JS fine from the static HTML,
				server islands stay runtime placeholders (static page, personalized placeholder — the
				flagship combination), but anything that calls the server still needs a server at runtime;
				a fully static deployment needs islands that don't.
			</p>
		</div>
	</section>

	<section id="router">
		<div class="section-header">
			<h2>SPA router</h2>
			<p class="section-lede">
				Opt-in. Without it, every navigation is a full document load, which is a valid way to run
				an islands app.
			</p>
		</div>
		<div class="prose">
			<p>
				Render <code>&lt;OgygiaRouter /&gt;</code> from <code>ogygia</code> in a layout to
				intercept same-origin link clicks, swap the body, and merge the head. Islands on the
				incoming page connect through the custom element lifecycle; islands on the outgoing page
				disconnect and unmount.
			</p>
			<p>
				View Transitions are on by default (<code>viewTransitions</code>). Pass
				<code>viewTransitions=&#123;false&#125;</code> for a plain swap when you do not want the
				API — or when a browser lacks support, the router falls back automatically.
			</p>
			<p>
				Island code keeps the Kit imports you already know —
				<code>$app/navigation</code>, <code>$app/state</code>, <code>$app/stores</code>.
				<code>goto</code>, <code>invalidate</code>, <code>beforeNavigate</code>, and the rest
				work with this router.
			</p>
			<p>
				The router does not re-execute inline <code>&lt;script&gt;</code> tags inserted by the
				swap (normal browser behavior for adopted nodes). Code that must run per navigation
				belongs in an island. Form POSTs are not intercepted; progressive enhancement keeps
				working.
			</p>
		</div>
		<CodeBlock html={data.ogygiaRouterHtml} />

		<h3 class="doc-subhead" id="persist">Persist layout chrome</h3>
		<div class="prose">
			<p>
				By default every island remounts on SPA navigation. Mark durable chrome — usually in a
				layout — with <code>data-ogygia-persist="key"</code>. When the same key exists on the
				outgoing and incoming body, the live node is kept (the new page's SSR for that key is
				discarded). Islands inside the persisted subtree stay mounted, so client state survives
				the swap.
			</p>
			<p>
				Keys must be unique per document (first wins). Persist nodes nested inside another
				persist ancestor are ignored — the outer key wins. If the key is missing on either side,
				that subtree replaces normally. See the
				<a href="/playground/router">router playground</a> for a side-by-side persist probe vs
				remounting route probe.
			</p>
		</div>
		<CodeBlock html={data.persistNavHtml} />

		<h3 class="doc-subhead">Link prefetch</h3>
		<div class="prose">
			<p>
				The router honours SvelteKit's <code>data-sveltekit-preload-data</code> and
				<code>data-sveltekit-preload-code</code> attributes, including the value grammar and
				ancestor inheritance you already know: <code>eager</code> prefetches immediately,
				<code>viewport</code> when the link scrolls into view, <code>hover</code> on hover (the
				default when the attribute is bare), <code>tap</code> on press, and
				<code>off</code>/<code>false</code> disables a broader ancestor opt-in. A prefetched page
				swaps in on click with no second request. Since this router delivers a page's "code" via
				the HTML swap itself (island chunks fetch on connect), <code>preload-code</code> maps to
				the same HTML prefetch — its extra triggers just warm the cache earlier. Put
				<code>data-sveltekit-preload-data="hover"</code> on a nav container and the whole subtree
				opts in.
			</p>
		</div>
	</section>

	<section id="patterns">
		<div class="section-header">
			<h2>Pesky patterns</h2>
			<p class="section-lede">
				The sharp edges, stated plainly. Every one of these is enforced by a build error, a dev
				warning, or a documented contract — nothing here fails silently.
			</p>
		</div>
		<div class="prose">
			<h3 class="doc-subhead">Captured host state is a snapshot. Do not mutate it.</h3>
			<p>
				Free variables an island references from host scope are serialized per-instance with
				devalue. That copy is one-way: writing to it inside the island updates nothing anywhere.
				If island <em>markup</em> writes to a captured variable — assignment, <code>++</code>,
				compound assignment, destructuring assignment, or <code>bind:</code> — the build fails
				with the variable and file named. If island <em>component code</em> mutates a captured
				object, Map, or Set at runtime, a dev-only deep proxy warns once per path; production
				ships the plain object with zero overhead. The fix is always the same: mutable state
				lives inside the island (<code>$state</code> seeded from the prop), not on the plain
				page. Corollary: two islands never share reactive state. If they must agree on
				something, both read it from the server (props or a shared <code>query</code>) — or they
				are actually one island.
			</p>

			<h3 class="doc-subhead">Functions and snippets do not cross the boundary</h3>
			<p>
				A host function referenced inside an island fails the render with the identifier named —
				devalue cannot serialize behaviour. A snippet defined outside an island and used inside
				it is a build error for the same reason (the reserved server-island
				<code>ogygiaFallback</code> snippet being the exception). Snippets <em>authored within</em> the
				island usage compile into the island itself and work exactly as normal Svelte — markup
				crosses as code, values cross as devalue, functions never cross.
			</p>

			<h3 class="doc-subhead">Page-level lifecycle is dead code</h3>
			<p>
				On a <code>csr = false</code> page, <code>+page.svelte</code> runs only on the server.
				<code>onMount</code>, <code>$effect</code>, and <code>afterNavigate</code> written there
				never fire. Client behaviour belongs in islands, where the <code>$app/navigation</code>,
				<code>$app/state</code>, and <code>$app/stores</code> imports all work (backed by the
				router and a per-page reactive snapshot). Islands remount on every navigation with fresh
				values — unless you opt into <code>data-ogygia-persist="key"</code> on layout chrome
				(same key on both pages keeps the live node and any islands inside it mounted).
			</p>

			<h3 class="doc-subhead">Inline scripts run once per document</h3>
			<p>
				ogygia does zero script processing. A nested inline <code>&lt;script&gt;</code> in your
				page HTML runs on a full document load and does <em>not</em> re-run after an SPA swap
				(standard browser behaviour for adopted nodes). Code that must run per navigation is an
				island — that is not a workaround, it is the model.
			</p>

			<h3 class="doc-subhead">Choose the boundary honestly</h3>
			<p>
				If the whole page needs JS anyway, stop fighting: give that route
				<code>csr = true</code> and let real Kit run it — islands coexist with fully-interactive
				pages in the same app, and on such a page an island degrades to a normal component with a
				dev note. Islands earn their keep when the page is mostly content and the interactivity
				is patchy. The smells worth acting on: a <code>load</code> island on every fold
				(you have rebuilt hydrate-everything with extra steps), one island passing state to a
				sibling (should be one island), a giant island wrapping the page (should be
				<code>csr = true</code>).
			</p>

			<h3 class="doc-subhead">Dev is not prod, in two places</h3>
			<p>
				The SSR query seed (the no-refetch trick) works in production builds; under
				<code>vite dev</code>, module isolation keeps the seed from reaching Kit's cache, so dev
				islands re-fetch when they get JS — cosmetic, dev-only, documented. And Vite's dev server
				compiles lazily, so first paints in dev can flash unstyled in ways prod never does.
				Judge visual behaviour in <code>vite preview</code>.
			</p>
		</div>
	</section>

	<section id="constraints">
		<div class="section-header">
			<h2>Constraints &amp; coupling</h2>
			<p class="section-lede">
				What the library leans on, and how hard.
			</p>
		</div>
		<div class="prose">
			<p>
				ogygia does not patch Kit or Svelte. It does <strong>deep-import Kit internals</strong> —
				the remote wire codec and the client remote-functions entry — by absolute path, which is
				why <code>@sveltejs/kit</code> is a peer with a deliberately tested range
				(<code>&gt;=2.70.2 &lt;3</code>): a Kit minor can move an internal. Pin Kit; bump
				deliberately; the verify suite tells you in a minute whether a bump is safe. Svelte 5.40+
				(runes, <code>createContext</code>, async SSR) and Vite 5–8 are the other peers. Runtime
				dependencies are three small libraries: <code>devalue</code>, <code>magic-string</code>,
				<code>estree-walker</code>.
			</p>
			<p>
				Kit's experimental flags for remote functions and async SSR are
				<strong>optional</strong> — enable them only if your app uses <code>.remote.ts</code> or
				top-level <code>await</code> in components. Both are still upstream-experimental; the
				coupling section of the README carries the current status. Prerendering, adapter-node,
				and Vercel-style adapters are exercised; anything serverless works for client islands, but
				server islands need a running origin (and remotes need a server too). Kit skips its client
				build when every route is <code>csr = false</code>; ogygia detects that and runs its own
				standalone island build, so an all-islands app needs no token csr page.
			</p>
		</div>
	</section>
</main>

<footer class="site-footer">
	<div class="shell footer-inner">
		<div class="footer-brand">
			<Logo size={28} stroke={2} decorative />
			<span class="footer-meta">ogygia · MIT · named for Calypso's island</span>
		</div>
		<div class="footer-links">
			<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
			<a href="https://www.npmjs.com/package/ogygia" target="_blank" rel="noreferrer">npm</a>
		</div>
	</div>
</footer>
