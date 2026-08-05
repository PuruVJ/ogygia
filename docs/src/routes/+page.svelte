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
	import ServerGreeting from '$lib/demos/ServerGreeting.svelte' with { defer: 'load' };
	// Presentational only — Shiki HTML comes from +page.server.ts (never ships to the browser).
	import CodeBlock from '$lib/CodeBlock.svelte';
	import PageHead from '$lib/PageHead.svelte';

	let { data }: { data: import('./$types').PageData } = $props();

	const docsLinks = [
		{ href: '#install', label: 'Install' },
		{ href: '#authoring', label: 'Authoring' },
		{ href: '#strategies', label: 'Strategies' },
		{ href: '#server-islands', label: 'Server' },
		{ href: '#lakes', label: 'Lakes' },
		{ href: '#router', label: 'Router' },
		{ href: '#patterns', label: 'Patterns' },
		{ href: '/playground', label: 'Playground', outbound: true }
	];
</script>

<PageHead
	description="SSR islands for SvelteKit. Ship a zero-JS page shell, mark components with import attributes, hydrate only what needs JavaScript."
/>

<div id="top"></div>

<SiteNav brandHref="#top" links={docsLinks} github />

<header class="hero">
	<Contours class="hero-contours" />
	<div class="shell hero-grid">
		<div class="hero-copy">
			<h1>ogygia</h1>
			<p class="hero-tagline">SSR islands for SvelteKit</p>
			<p>
				Ship a page shell with zero Kit JS. Mark components with an import attribute and they
				hydrate on their own schedule. Everything else stays plain HTML.
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

<div class="toc-fixed" aria-hidden="true">
	<Toc />
</div>

<main class="shell docs-main">
	<section id="what">
		<h2>What it does</h2>
		<div class="what-grid">
			<div class="prose">
				<p>
					SvelteKit's default is to hydrate the whole route. That is the right call when most of
					the page is interactive. It is the wrong call when the shell is mostly static copy and
					only a handful of widgets need JavaScript.
				</p>
				<p>
					ogygia inverts that default. You set <code>csr = false</code> so the page ships as a
					server-rendered document with no Kit client runtime. Components you mark with an
					import attribute become <strong>regions</strong>: each gets serialized props, its own
					client chunk, and a hydration (or defer) strategy. Everything else stays inert HTML.
				</p>
				<p>
					The library does not patch Kit. It is a Vite plugin plus a small runtime and a server
					handle. Runtime deps are <code>devalue</code>, <code>magic-string</code>, and
					<code>estree-walker</code>. Peers are Svelte 5.40+, Kit 2.70+, and Vite 5 through 8.
					Kit is deep-imported for a few internals (remote wire codec, client remote entry), so
					treat the Kit range as tested rather than a soft semver promise.
				</p>
			</div>
			<div class="archipelago" aria-hidden="true">
				<span class="archipelago-label">route.html · server-rendered shell</span>
				<div class="archipelago-shell">
					<div class="archipelago-island">Counter.svelte</div>
					<div class="archipelago-island">Search.svelte</div>
				</div>
			</div>
		</div>
		<div class="prose" style="margin-top: 1.75rem;">
			<p>
				Under the hood this is the unified <strong>region model</strong>. Every boundary has two
				axes: <code>render</code> (<code>page</code> or <code>defer</code>) and
				<code>hydrate</code> (<code>load</code>, <code>idle</code>, <code>visible</code>, a media
				query, or off). The nearest boundary above a node wins. That rule is why nesting is safe:
				an island inside an island does not double-hydrate.
			</p>
		</div>
	</section>

	<section id="install">
		<h2>Install</h2>
		<div class="prose">
			<p>
				Install the package, register the Vite plugin <em>before</em>
				<code>sveltekit()</code>, enable the experimental flags Kit needs, drop in the server
				handle, and turn CSR off on the routes that should be island shells.
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
				<code>enforce: 'pre'</code>). Optional knobs: a default
				<code>visible.margin</code> for IntersectionObserver, and named
				<code>presets</code> you reference from imports.
			</p>
		</div>
		<CodeBlock html={data.viteConfigHtml} />

		<h3 class="doc-subhead">svelte.config.js</h3>
		<div class="prose">
			<p>
				Async SSR and remote functions are required. Without them, deferred server islands and
				nested region context will not compile or run correctly.
			</p>
		</div>
		<CodeBlock html={data.svelteConfigHtml} />

		<h3 class="doc-subhead">Layout + hooks</h3>
		<div class="prose">
			<p>
				<code>csr = false</code> is what removes Kit's client runtime from the shell. Kit skips
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

	<section id="authoring">
		<h2>Authoring</h2>
		<div class="prose">
			<p>
				A component becomes a region when its import carries exactly one of
				<code>hydrate</code>, <code>defer</code>, or <code>preset</code>. Import-attribute values
				must be string literals (ES spec). Every usage of that marked binding is a region.
			</p>
		</div>
		<CodeBlock html={data.authoringImportsHtml} />
		<div class="prose">
			<p>
				Props cross the boundary through <strong>devalue</strong>. <code>Date</code>,
				<code>Map</code>, <code>Set</code>, <code>BigInt</code>, and nested plain objects survive.
				Functions do not. Free variables from outer scope that the island closes over are
				captured automatically and passed as props. Children and snippets work; a snippet defined
				outside a region but used inside is a build error, except the reserved server-island
				<code>fallback</code>.
			</p>
			<p>
				You cannot put option keys on the import itself. Margins and similar tuning belong in
				plugin config or a preset. Unknown presets, unknown keys, mixing
				<code>preset</code> with another key, and <code>defer</code> + <code>hydrate</code>
				together are build errors (the last one is roadmap).
			</p>
			<p>
				Each island is an independent Svelte app. Islands do not share reactive state. If two
				regions need the same data, pass it as props from the server shell, or fetch inside each
				island (remote functions work).
			</p>
			<p>
				The same module can be imported twice with different strategies. Per-use bindings are
				how you hydrate one counter on load and another instance of the same component on
				visible.
			</p>
		</div>

		<h3 class="doc-subhead">The one nesting rule</h3>
		<div class="prose">
			<p>
				Every composition question has the same answer: <strong>a region hydrates itself only if
				the nearest region boundary above it is not hydrated.</strong> Everything below falls out
				of that sentence; none of it is special-cased.
			</p>
			<p>
				An island may import another island. The inner one sits inside a hydrated boundary, so it
				degrades to a plain component and hydrates exactly once, with its parent; its own strategy
				is ignored and a dev-only warning names it. An island inside a <em>lake</em> is the
				opposite case: the lake made its subtree dead again, so the inner island self-hydrates.
				Alternation — shell → island → lake → island — is legal all the way down. A server island
				nested inside an island renders inline with its parent (its <code>defer</code> is ignored
				there; DESIGN.md records the roadmap semantics).
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
				<code>hydrate</code> / <code>render</code> effect. Use it only when you want to mark a
				region usage in source for humans (or for a future hook). It is not
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
				Pick when JavaScript arrives. The blocks below are real regions on this page. Use the JS
				toggle to compare the hydrated UI with the static HTML the server shipped.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy" id="client-load">
				<h3><code>hydrate: 'load'</code></h3>
				<div class="prose">
					<p>
						Default for critical UI. The runtime hydrates the region as soon as the
						<code>ogygia-region</code> custom element connects (after DOM ready). The island's
						module is part of the critical client graph for that page.
					</p>
					<p>
						Use it for above-the-fold controls the page cannot function without: primary nav,
						search, the first form. Avoid sprinkling load across the whole page; every load
						island competes with LCP and hydration work on the main thread.
					</p>
				</div>
				<LoadDemo codeHtml={data.loadCode} />
			</div>

			<div class="strategy" id="client-idle">
				<h3><code>hydrate: 'idle'</code></h3>
				<div class="prose">
					<p>
						Defers hydration until the browser is idle via
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
						Hydration is gated on <code>IntersectionObserver</code>. Until the region enters
						(or approaches) the viewport, it remains SSR HTML. That is the usual choice for
						below-the-fold charts, comment trees, related-content carousels, and heavy embeds.
					</p>
					<p>
						Configure a default <code>rootMargin</code> on the plugin
						(<code>visible.margin</code>) or per preset so islands can start loading slightly
						before they scroll on screen. A margin like <code>'200px'</code> is a common
						pre-warm. Without a margin, hydration starts at the moment of intersection.
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
						<code>matchMedia</code>: if the query already matches, the island hydrates
						immediately; otherwise it waits for a change event. This is how you ship
						mobile-only drawers or desktop-only inspectors without paying for their JS on the
						other viewport.
					</p>
					<p>
						The demo region below uses <code>(max-width: 600px)</code>. On a wide laptop it may
						stay static until you narrow the window. That is the strategy working as designed,
						not a broken preview.
					</p>
				</div>
				<MediaDemo codeHtml={data.mediaCode} />
			</div>
		</div>
	</section>

	<section id="server-islands">
		<div class="section-header">
			<h2>Server islands</h2>
			<p class="section-lede">
				<code>defer</code> moves rendering off the page SSR and onto a signed fetch. The browser
				still gets HTML. It does not get that component's JS.
			</p>
		</div>
		<div class="prose">
			<p>
				At page render time, only the reserved <code>fallback</code> snippet is written into the
				document. The component itself is not executed yet. Props are serialized with devalue and
				HMAC-signed so the endpoint can reject tampering. A
				<code>&lt;link rel="preload" as="fetch"&gt;</code> hint (skipped when prerendering) starts
				the request during HTML parse; the runtime reuses that preload.
			</p>
			<p>
				The fetch hits the ogygia handle on the same origin, so cookies flow and the deferred
				render sees a real request context. Remote functions and <code>await</code> work during
				that render. CSS for the component is still collected through the page import graph and
				linked in <code>&lt;head&gt;</code>. On a <code>csr = false</code> page, zero component JS
				is shipped for the deferred island.
			</p>
			<p>
				Signing bakes a per-build HMAC key into the server bundle by default (no setup). Set
				optional <code>OGYGIA_SECRET</code> (shell, CI, or <code>.env</code>) when rolling deploys
				or cached HTML must keep verifying across builds. The default endpoint path is
				<code>/🏝️ogygia🏝️</code> (emoji brackets keep it from colliding with app routes).
			</p>
			<p>
				The <code>defer</code> value is the <strong>fetch timing</strong> for the hole — the same
				scheduler vocabulary as <code>hydrate</code>, which is the symmetry at the heart of the
				region model: one axis says when HTML arrives, the other says when JS wakes.
				<code>'load'</code> fetches immediately (and is the only value that emits the preload
				hint), <code>'idle'</code> waits for <code>requestIdleCallback</code>,
				<code>'visible'</code> holds the fetch until the hole scrolls into view — the server does
				no work for content nobody reached — and a media query fetches when it matches. The old
				boolean spelling <code>defer: 'true'</code> is a build error pointing at
				<code>'load'</code>.
			</p>
			<p>
				Good fits: personalized greetings, account chips, slow fragments on an otherwise cacheable
				page. Prerendered routes keep server islands as runtime holes. v1 does not hydrate after
				the HTML swap; pairing <code>defer</code> with a hydrate strategy is explicitly roadmap.
				Override the endpoint with <code>ogygiaHandle(&#123; endpoint &#125;)</code> if the emoji
				route offends your logs.
			</p>
		</div>
		<ServerDemo codeHtml={data.serverCode}>
			{#snippet live()}
				<ServerGreeting salutation="Aloha">
					{#snippet fallback()}
						<div class="widget widget--greeting">
							<strong>Fetching island…</strong>
							<p class="widget-meta">Fallback while the server renders</p>
						</div>
					{/snippet}
				</ServerGreeting>
			{/snippet}
		</ServerDemo>
	</section>

	<section id="lakes">
		<div class="section-header">
			<h2>Lakes</h2>
			<p class="section-lede">
				A lake is hydration switched off again, inside an island. Same declaration, opposite
				polarity.
			</p>
		</div>
		<div class="prose">
			<p>
				Import a component <code>with &#123; hydrate: 'none' &#125;</code> and use it inside a
				hydrated island: that subtree <strong>freezes</strong>. It server-renders inline like
				everything else, but its component code ships in <em>no</em> client chunk — the island's
				browser module swaps the import for a placeholder — and the runtime lifts the lake's SSR
				DOM out before the parent hydrates, then puts it back untouched. The parent island is
				fully interactive around a hole of dead, free HTML.
			</p>
			<p>
				The contract is the same honesty islands demand elsewhere: lake content is furniture.
				Props changes after the page render do nothing; event handlers inside are inert. If the
				parent island destroys and re-creates the frozen spot (an <code>&#123;#if&#125;</code>
				toggle), <code>remount</code> on a <code>hydrate: 'none'</code> preset decides what happens:
				<code>'cache'</code> (default) restores the SSR DOM,
				<code>'empty'</code> leaves the spot blank,
				<code>'swr'</code> paints the cache then fetches fresh HTML
				(<code>remount: &#123; strategy: 'swr', when: 'idle' &#125;</code> in
				<code>ogygia(&#123; presets &#125;)</code> — not inline). Islands inside wait for the
				revalidate swap before hydrating. The signed endpoint is SSR-minted only (no client remint;
				same 24h capability window as deferred islands).
			</p>
			<p>
				Where it pays: a heavy rendered markdown blob inside an interactive editor shell, a big
				SVG legend inside a live chart, a long syntax-highlighted code listing inside a
				collapsible panel. All the markup, none of the JavaScript. And because the nesting rule is
				uniform, an island authored <em>inside</em> a lake wakes up again on its own — frozen
				water can contain live land.
			</p>
			<p>
				A <code>hydrate: 'none'</code> import used in the dead page shell is a no-op (the shell is
				already dead) and dev-warns so you notice. The value is the string
				<code>'none'</code> — <code>'false'</code> is a build error that points you at it.
			</p>
		</div>
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
				The boring path first: <code>+page.server.ts</code> loads run on every request, the shell
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
				in-process, and its result is <strong>seeded</strong> into the client cache so hydration
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
				<code>prerender = true</code> on a page: normal islands hydrate fine from the static
				HTML, server islands stay runtime holes (static page, personalized hole — the flagship
				combination), but anything that calls the server still needs a server at runtime; a fully
				static deployment needs islands that don't.
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
				nearest-ancestor inheritance you already know: <code>eager</code> prefetches immediately,
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
				lives inside the island (<code>$state</code> seeded from the prop), not in the dead
				shell. Corollary: two islands never share reactive state. If they must agree on
				something, both read it from the server (props or a shared <code>query</code>) — or they
				are actually one island.
			</p>

			<h3 class="doc-subhead">Functions and snippets do not cross the boundary</h3>
			<p>
				A host function referenced inside an island fails the render with the identifier named —
				devalue cannot serialize behaviour. A snippet defined outside an island and used inside
				it is a build error for the same reason (the reserved server-island
				<code>fallback</code> snippet being the exception). Snippets <em>authored within</em> the
				island usage compile into the island itself and work exactly as normal Svelte — markup
				crosses as code, values cross as devalue, functions never cross.
			</p>

			<h3 class="doc-subhead">Page-level lifecycle is dead code</h3>
			<p>
				On a <code>csr = false</code> page, <code>+page.svelte</code> runs only on the server.
				<code>onMount</code>, <code>$effect</code>, and <code>afterNavigate</code> written there
				never fire. Client behaviour belongs in islands, where the <code>$app/navigation</code>,
				<code>$app/state</code>, and <code>$app/stores</code> imports all work (backed by the
				router and a per-page reactive snapshot). Note the snapshot semantics: islands remount on
				every navigation with fresh values — unless you opt into
				<code>data-ogygia-persist="key"</code> on layout chrome (same key on both pages keeps the
				live node and any islands inside it mounted).
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
				If the whole page hydrates anyway, stop fighting: give that route
				<code>csr = true</code> and let real Kit run it — islands coexist with fully-hydrated
				pages in the same app, and on such a page an island degrades to a normal component with a
				dev note. Islands earn their keep when the shell is mostly content and the interactivity
				is patchy. The smells worth acting on: a <code>load</code> island on every fold
				(you have rebuilt hydrate-everything with extra steps), one island passing state to a
				sibling (should be one island), a giant island wrapping the page (should be
				<code>csr = true</code>).
			</p>

			<h3 class="doc-subhead">Dev is not prod, in two places</h3>
			<p>
				The SSR query seed (the no-refetch trick) works in production builds; under
				<code>vite dev</code>, module isolation keeps the seed from reaching Kit's cache, so dev
				islands re-fetch on hydration — cosmetic, dev-only, documented. And Vite's dev server
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
				Kit's experimental flags for remote functions and async SSR must be on, and both features
				are upstream-experimental — the coupling section of the README carries the current
				status. Prerendering, adapter-node, and Vercel-style adapters are exercised; anything
				serverless works for client islands, but server islands and remote functions need a
				running server. Kit skips its client build when every route is <code>csr = false</code>;
				ogygia detects that and runs its own standalone island build, so an all-islands app needs
				no token csr page.
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
