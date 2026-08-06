<script lang="ts">
	import Contours from '$lib/Contours.svelte';
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
	import SiteFooter from '$lib/SiteFooter.svelte';
	import '$lib/styles/widget.css';

	let { data }: { data: import('./$types').PageData } = $props();
</script>

<PageHead
	description="SSR islands for SvelteKit. No Kit client bootstrap — a ~4.5 KB runtime (custom element + router), and JS only for the components you mark."
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
				about <strong>4.5&nbsp;KB</strong> min+brotli. Mark components with an import attribute and
				they become interactive on a schedule; everything else stays server HTML.
			</p>
			<div class="btn-row">
				<a class="btn btn--primary" href="#adoption">Adoption</a>
				<a class="btn btn--ghost" href="#install">Install</a>
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
				<code>sveltekit()</code>, and add the server handle. Then convert routes with
				<code>csr = false</code> — see <a href="#adoption">Adoption</a> for rolling that out
				without breaking existing Kit pages.
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
				<code>enforce: 'pre'</code>). In monorepos it adds its package root to Vite's
				<code>server.fs.allow</code> so absolute shim/runtime resolves are not blocked outside
				the app directory. For every option, see <a href="#plugin">Plugin config</a>.
			</p>
		</div>
		<CodeBlock html={data.viteConfigHtml} />

		<h3 class="doc-subhead">hooks.server.ts</h3>
		<div class="prose">
			<p>
				<code>ogygiaHandle()</code> serves the signed island endpoint used by
				<code>defer</code> and lake <code>remount: 'swr'</code>. Compose it with
				<code>sequence()</code> if you already have handles. Override the path with
				<code>ogygiaHandle(&#123; endpoint: '/my-islands' &#125;)</code> if you do not want the
				default clash-safe emoji route.
			</p>
		</div>
		<CodeBlock html={data.layoutAndHooksHtml} />
	</section>

	<section id="adoption">
		<div class="section-header">
			<h2>Adoption</h2>
			<p class="section-lede">
				Convert one route at a time. Existing Kit pages keep working — including with
				<code>&lt;OgygiaRouter /&gt;</code> in the root layout.
			</p>
		</div>
		<div class="prose">
			<p>
				ogygia is not an all-or-nothing flip. Wire the plugin and handle once, then opt routes into
				islands when you are ready. Everything else stays ordinary SvelteKit
				(<code>csr = true</code> by default).
			</p>
		</div>

		<h3 id="adoption-one-route" class="doc-subhead">One route at a time</h3>
		<div class="prose">
			<p>
				On a route (or layout group) you want as an islands shell, set
				<code>export const csr = false</code> and mark the interactive imports with
				<code>hydrate</code> / <code>defer</code> / <code>preset</code>. Sibling routes with no
				such export keep Kit’s client bootstrap and hydrate as they do today.
			</p>
			<p>
				A layout-level <code>csr = false</code> applies to every child until a deeper layout or
				page sets <code>csr = true</code> again — useful when a whole section is ready (docs,
				marketing) while <code>/app</code> stays Kit.
			</p>
		</div>
		<CodeBlock html={data.adoptionMigrateHtml} />

		<h3 id="adoption-router" class="doc-subhead">Root router without breaking Kit pages</h3>
		<div class="prose">
			<p>
				You can render <code>&lt;OgygiaRouter /&gt;</code> in the outermost layout even while most
				routes are still Kit pages. The router only intercepts clicks when the document is an
				islands shell (no Kit bootstrap). On a <code>csr = true</code> page it stays idle — Kit
				owns navigation.
			</p>
			<ul>
				<li>
					<strong>Islands → Kit page:</strong> full document load. Kit’s inline bootstrap cannot
					run after an SPA body swap, so the router hands off on purpose.
				</li>
				<li>
					<strong>Islands → islands:</strong> SPA body swap (and View Transitions if enabled).
				</li>
				<li>
					<strong>Kit → anywhere:</strong> Kit’s client router (or a full load), unchanged.
				</li>
				<li>
					<strong>Page without the router marker:</strong> full load from an islands SPA (opt out
					of SPA for a subtree by omitting <code>&lt;OgygiaRouter /&gt;</code> there).
				</li>
			</ul>
			<p>
				Live check: this docs site keeps the router in the root layout and ships a
				<a href="/kit"><code>csr = true</code></a> coexistence route.
			</p>
		</div>

		<h3 id="adoption-mixed" class="doc-subhead">Islands on a Kit page</h3>
		<div class="prose">
			<p>
				An import marked <code>with &#123; hydrate &#125;</code> on a <code>csr = true</code> page
				still works — Kit hydrates the whole tree, so the island becomes a normal component (ogygia
				skips self-hydration and logs a dev note). Useful while you are mid-migration or sharing a
				component between shells. The directive earns its keep once that route is
				<code>csr = false</code>.
			</p>
		</div>

		<h3 id="adoption-end" class="doc-subhead">All-islands apps</h3>
		<div class="prose">
			<p>
				When <em>every</em> route is <code>csr = false</code>, Kit skips its client build. ogygia
				detects that and runs a standalone client build so island chunks and the runtime still
				ship — you do not need a token <code>csr = true</code> page. Until then, any remaining Kit
				route keeps Kit’s client build available for the whole app.
			</p>
			<p>
				Suggested order: plugin + handle → convert a low-risk content route → add the root router
				when you want SPA between islands pages → grow layout groups → eventually drop the last
				Kit route if you want a pure islands shell.
			</p>
		</div>
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
				<code>preset</code> by default (rename via <code>importKeys</code> if needed) — put
				<code>margin</code>, <code>remount</code>, and shared strategy bundles in the plugin
				options below.
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
						<td><code>importKeys</code></td>
						<td><code>hydrate</code> / <code>defer</code> / <code>preset</code></td>
						<td>Rename those import-attribute keys if another tool already claims them</td>
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
					<tr>
						<td><code>regionTtl</code></td>
						<td><code>3600</code></td>
						<td>Capability URL lifetime in seconds (clamp 60–86400)</td>
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

		<h3 id="plugin-importKeys" class="doc-subhead">importKeys</h3>
		<div class="prose">
			<p>
				Proud defaults: import attributes use <code>hydrate</code>, <code>defer</code>, and
				<code>preset</code>. If another tool already claims one of those names on the same
				imports, rename only what you need:
			</p>
			<pre><code>ogygia(&#123;
  importKeys: &#123;
    hydrate: 'ogygiaHydrate',
    defer: 'ogygiaDefer',
    preset: 'ogygiaPreset'
  &#125;
&#125;)</code></pre>
			<p>
				Then write
				<code>with &#123; ogygiaHydrate: 'load' &#125;</code> (etc.) in source. Preset
				<em>definitions</em> in plugin config still use the canonical field names
				<code>hydrate</code> / <code>defer</code> / <code>margin</code> / <code>remount</code> —
				only the import-attribute spellings change. Partial overrides are fine; omitted roles keep
				the defaults. The three names must be distinct JS identifiers.
			</p>
		</div>

		<h3 id="plugin-rate" class="doc-subhead">rateLimit</h3>
		<div class="prose">
			<p>
				Protects the signed deferred-region / lake-remount endpoint served by
				<code>ogygiaHandle()</code>. Default is
				<code>&#123; max: 60, windowMs: 60_000 &#125;</code> — sixty requests per IP per minute.
				Pass <code>rateLimit: false</code> to disable (or <code>max: 0</code>). Values are baked
				into the server bundle at build time. The handle also rejects non-GET/HEAD, cross-site
				<code>Sec-Fetch-Site</code> when the browser sends it, and non-hex region ids — defense in
				depth around the capability URL.
			</p>
		</div>

		<h3 id="plugin-session" class="doc-subhead">sessionCookie</h3>
		<div class="prose">
			<p>
				Opt-in. Pass a cookie name (string) to seal that cookie’s value into the region
				capability MAC. Harvested defer/remount URLs then fail verification without the same
				cookie. Empty or missing cookies stay unbound (same as the default
				<code>false</code>). Useful when personalized HTML must not be replayable from a stolen
				URL alone. Left off by default so prerendered defer holes remain fetchable without a
				request cookie — see
				<a
					href="https://github.com/PuruVJ/ogygia/blob/main/INVARIANTS.md#capability-url--bearer-token-in-the-query-string"
					target="_blank"
					rel="noreferrer">INVARIANTS · CAPABILITY-URL</a
				>. Reading cookies during deferred SSR (same-origin fetch) is unrelated — that is ordinary
				request context, not MAC binding.
			</p>
		</div>

		<h3 id="plugin-ttl" class="doc-subhead">regionTtl</h3>
		<div class="prose">
			<p>
				Lifetime of signed region capability URLs in <strong>seconds</strong> (default
				<code>3600</code> — one hour). Clamped to <code>[60, 86400]</code>. Shorter TTLs limit
				replay of harvested URLs; longer TTLs keep deferred holes valid on long-lived tabs.
				Prerendered pages share the same window.
			</p>
			<p>
				<strong>Props in the URL are not secret.</strong> The MAC protects integrity, not
				confidentiality. Do not pass tokens or PII as deferred-region props — they appear in
				query strings (logs, history, Referer). Region responses send
				<code>Referrer-Policy: no-referrer</code> so third-party assets inside the hole do not
				leak the capability URL.
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
					<code>OGYGIA_SECRET</code> (≥16 UTF-8 bytes in production builds) so rolling deploys
					and long-lived cached HTML keep verifying. The plugin HKDF-derives separate MAC and
					id-salt keys from that material.
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
				serialized with devalue into a signed capability URL (integrity via HMAC — not
				confidentiality; see <a href="#plugin-ttl">regionTtl</a>). The fetch hits
				<code>ogygiaHandle()</code> on the same origin, so cookies flow and the deferred render
				sees a real request context. Remote functions and <code>await</code> work there. CSS is
				still collected through the page import graph.
			</p>
			<p>
				Signing uses a per-build random key baked into the <em>server</em> bundle by default, or a
				stable <code>OGYGIA_SECRET</code> when set (HKDF-derived MAC key; ≥16 UTF-8 bytes in
				production builds — <a href="#plugin-secret">OGYGIA_SECRET</a>). Default endpoint:
				<code>/🏝️ogygia🏝️</code>. Override with
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
						<th scope="col">Shorthand</th>
						<th scope="col">On remount</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td><code>'cache'</code></td>
						<td>Default. Restore the SSR DOM. No network. ≡ <code>&#123; revalidate: false &#125;</code></td>
					</tr>
					<tr>
						<td><code>'empty'</code></td>
						<td>Leave the spot blank (no restored HTML, no fetch).</td>
					</tr>
					<tr>
						<td><code>'swr'</code></td>
						<td>
							Paint cache, then revalidate. ≡ <code>&#123; revalidate: 'load' &#125;</code>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="prose">
			<p>Object form (shared by cache + SWR):</p>
			<p>
				<code
					>remount: &#123; revalidate?: false | schedule, maxAge?: number | '30s' | '5m' | '1h',
					onExpire?: 'empty' | 'fetch' &#125;</code
				>
			</p>
			<ul>
				<li>
					<code>revalidate</code> — <code>false</code> (or omit with only <code>maxAge</code>) =
					pure cache; a schedule (<code>'load'</code> | <code>'idle'</code> |
					<code>'visible'</code> | media) = SWR after painting stale.
				</li>
				<li>
					<code>maxAge</code> — how long the client lake cache may be shown. Number = ms, or a
					duration string.
				</li>
				<li>
					<code>onExpire</code> — past <code>maxAge</code>: <code>'empty'</code> (default for
					cache) leaves the spot blank; <code>'fetch'</code> (default for SWR) skips stale and
					hits the endpoint. <code>'fetch'</code> requires a <code>revalidate</code> schedule.
				</li>
			</ul>
			<p>
				<code>swr</code> / <code>revalidate: schedule</code> reuse the signed region endpoint
				(<code>ogygiaHandle()</code>, <code>rateLimit</code>, <code>sessionCookie</code>,
				<code>OGYGIA_SECRET</code>). Capability URLs are SSR-minted only (default TTL 1h via
				<code>regionTtl</code>). Islands inside
				the lake wait for the revalidate swap before they get JS.
			</p>
			<p>
				Fetch-path constraints (build errors otherwise): the lake usage must be a leaf — no
				children / snippets — and only plain serializable attributes or spreads (no
				<code>bind:</code>, no event/callback props). The component path must resolve
				(<code>$lib/…</code> or relative). If props cannot cross the wire at mint time, the
				endpoint is omitted and remount behaves like <code>'cache'</code>.
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
				hit. On SPA navigation, SSR remote seeds clear before the body swap and Kit's
				query/live instance maps clear after it — so <code>query.live</code> opens a fresh SSE
				on the next page instead of reusing a spent connection. Those maps live on a
				<code>globalThis</code> singleton so Vite duplicate-module loads still share one cache.
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
			<p>
				<strong>Page seed.</strong> On <code>csr = false</code> shells, ogygia injects a document
				snapshot (<code>application/ogygia-page</code>) so islands reading
				<code>$app/state</code> / <code>page.data</code> see the same client-visible contract as Kit
				<code>csr = true</code>. That is intentional — enabling ogygia is not “server-only load
				data” the way a stock <code>csr = false</code> page without islands would be.
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
				disconnect and unmount. For putting the router in the root layout while some routes stay
				Kit, see <a href="#adoption-router">Adoption · Root router</a>.
			</p>
			<p>
				View Transitions are on by default (<code>viewTransitions</code>). Pass
				<code>viewTransitions=&#123;false&#125;</code> for a plain swap when you do not want the
				API — or when a browser lacks support, the router falls back automatically. Same-route
				hash jumps (<code>/docs#install</code> → <code>/docs#router</code>) skip the transition
				and only scroll. Cross-route navigations still use View Transitions when the target has a
				hash (<code>/a</code> → <code>/b#section</code>); the hash scrolls after the swap.
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
				the same HTML prefetch — its extra triggers just warm the cache earlier. This site sets
				<code>off</code> on <code>&lt;body&gt;</code> and opts the sidenav back in with
				<code>data-sveltekit-preload-data="hover"</code> so nav links warm on hover without
				prefetching every in-page link.
			</p>
		</div>
	</section>

	<section id="hmr">
		<div class="section-header">
			<h2>Dev HMR</h2>
			<p class="section-lede">
				Under <code>csr = false</code>, Kit never boots a client module graph — so stock Vite HMR
				has nothing to talk to. <code>ogygia()</code> bridges that for you. No extra config.
			</p>
		</div>
		<div class="prose">
			<p>
				In <code>vite dev</code>, the plugin injects a small bridge
				(<code>virtual:ogygia/dev-hmr</code>) that pulls in <code>@vite/client</code> and
				eager-imports app CSS under <code>/src</code> so Vite can soft-update those files. Kit’s
				FOUC bag (<code>&lt;style data-sveltekit&gt;</code>) stays in place — under
				<code>csr = false</code> that bag is how page and component CSS is delivered, and removing
				it blanks the document (including after SPA navigations). If Vite reports
				<code>vite:error</code>, the bridge falls back to a full document reload.
			</p>
			<p>What happens on save depends on what you edited:</p>
		</div>
		<div class="map-scroll">
			<table class="map-table">
				<thead>
					<tr>
						<th scope="col">You change</th>
						<th scope="col">Behavior</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>CSS / SCSS / etc. under <code>src/</code></td>
						<td>Soft HMR — styles update without a reload</td>
					</tr>
					<tr>
						<td>Shared modules (e.g. <code>.ts</code>) imported by islands</td>
						<td>Soft HMR through the island graph</td>
					</tr>
					<tr>
						<td
							>Island <em>entry</em> <code>.svelte</code> (the file you import with
							<code>hydrate</code> / <code>defer</code> / <code>preset</code>)</td
						>
						<td>Full reload — soft HMR through the virtual island wrapper is unreliable</td>
					</tr>
					<tr>
						<td
							>Route shells (<code>+page</code>, <code>+layout</code>, <code>+error</code>,
							<code>+server</code>, <code>+hooks</code>, …)</td
						>
						<td
							>Full reload — those files never join the browser graph under
							<code>csr = false</code></td
						>
					</tr>
					<tr>
						<td>Host rewrite (add/remove/reorder island imports in a page or layout)</td>
						<td
							>Full reload; virtual islands for that host are invalidated so renamed
							components (e.g. SiteNav → SideNav) don’t keep a stale module id</td
						>
					</tr>
					<tr>
						<td>Delete an island entry component</td>
						<td>Full reload; dangling virtual islands are dropped</td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="prose">
			<p>
				Production builds do not ship the bridge. Judge final paint in
				<code>vite preview</code> / a real deploy — see also
				<a href="#patterns">Pesky patterns → Dev is not prod</a>.
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

			<h3 class="doc-subhead" id="patterns-dynamic-import">
				No <code>import()</code> + <code>with &#123; hydrate &#125;</code>
			</h3>
			<p>
				Dynamic <code>import()</code> can take import attributes as
				<code>import(mod, &#123; with: &#123; type: 'json' &#125;&#125;)</code> — that is the language
				shape, and Vite can surface those options to plugins. It is <em>not</em> how you author an
				island. Region keys (<code>hydrate</code> / <code>defer</code> / <code>preset</code>) only
				apply on a <strong>static</strong>
				<code>import X from '…' with &#123; … &#125;</code> paired with a static
				<code>&lt;X /&gt;</code> tag so SSR can emit the shell. Vite strips attributes from emitted
				dynamic imports for browser compatibility; runtimes reject unknown keys like
				<code>hydrate</code> if they remain. ogygia therefore <strong>fails the build</strong> if it
				sees <code>import(…, &#123; with: &#123; hydrate|defer|preset &#125;&#125;)</code> — no silent
				no-op.
			</p>
			<p>
				Want a chunk only after a click? That is client-only lazy mount: a host island does plain
				<code>await import('./Comp.svelte')</code> (no region attributes) and renders
				<code>&lt;Comp /&gt;</code>. What you get is a <strong>regular</strong> Svelte component in
				that island’s tree — Vite splits the chunk; no second island, no SSR shell for the lazy
				piece. Live demo:
				<a href="/playground/on-demand">Playground → Client-only lazy mount</a>.
			</p>
			<CodeBlock html={data.lazyClientMountHtml} />
			<p>
				To delay an actual <em>island</em> boundary until click, keep the static region import and
				gate the tag with <code>&#123;#if&#125;</code> instead:
			</p>
			<CodeBlock html={data.delayedIslandIfHtml} />

			<h3 class="doc-subhead">Dev is not prod, in two places</h3>
			<p>
				The SSR query seed (the no-refetch trick) works in production builds; under
				<code>vite dev</code>, module isolation keeps the seed from reaching Kit's cache, so dev
				islands re-fetch when they get JS — cosmetic, dev-only, documented. And Vite's dev server
				compiles lazily, so first paints in dev can flash unstyled in ways prod never does.
				Judge visual behaviour in <code>vite preview</code>. HMR under
				<code>csr = false</code> is real (soft CSS / shared modules, full reload for route shells
				and island entries) — see <a href="#hmr">Dev HMR</a>.
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
			<p>
				Generated island wrappers are Vite virtual modules
				(<code>virtual:ogygia/island/&lt;id&gt;.svelte</code>) — they are not written under
				<code>src/</code>. Sourcemaps and tooling should treat them as virtual, not as missing
				on-disk <code>.ogygia/</code> files.
			</p>
		</div>
	</section>
</main>

<SiteFooter meta="ogygia · MIT · named for Calypso's island">
	{#snippet links()}
		<a href="https://github.com/PuruVJ/ogygia" target="_blank" rel="noreferrer">GitHub</a>
		<a href="https://www.npmjs.com/package/ogygia" target="_blank" rel="noreferrer">npm</a>
	{/snippet}
</SiteFooter>

<style>
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

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(14px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.hero-grid > :global(*) {
		animation: rise 600ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}

	.hero-grid > :global(*:nth-child(2)) {
		animation-delay: 80ms;
	}

	.what-grid {
		display: grid;
		grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		gap: clamp(2rem, 4vw, 4rem);
		align-items: start;
	}

	.archipelago {
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		padding: 1.25rem;
		background: var(--bg-raised);
		min-height: 220px;
		display: grid;
		gap: 0.75rem;
	}

	.archipelago-shell {
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-sm);
		padding: 1rem;
		min-height: 160px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		align-content: start;
	}

	.archipelago-island {
		border: 1px solid var(--accent-line);
		border-radius: var(--r-sm);
		padding: 0.75rem;
		font: 500 0.75rem/1.4 var(--font-mono);
		color: var(--accent);
		background: var(--accent-deep);
	}

	.archipelago-label {
		font: 400 0.6875rem/1.4 var(--font-mono);
		color: var(--text-faint);
		letter-spacing: 0.04em;
	}

	.map-scroll {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--bg-raised);
		box-shadow: var(--shadow-panel);
	}

	.map-table {
		width: 100%;
		min-width: 40rem;
		border-collapse: collapse;
		font-size: 0.875rem;
		line-height: 1.45;
	}

	.map-table :global(th),
	.map-table :global(td) {
		padding: 0.75rem 1rem;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--line);
	}

	.map-table :global(th) {
		font: 500 0.6875rem/1.4 var(--font-mono);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
		background: var(--bg-sunken);
		border-bottom-color: var(--line-strong);
	}

	.map-table :global(tbody tr:last-child td) {
		border-bottom: none;
	}

	.map-table :global(td:first-child) {
		white-space: nowrap;
		color: var(--text);
	}

	.map-table :global(td) {
		color: var(--text-dim);
	}

	.map-table :global(code) {
		font-size: 0.8125rem;
		color: var(--accent);
	}

	.map-table :global(em) {
		font-style: italic;
		color: var(--text-faint);
	}

	.map-nest {
		margin: 1.25rem 0 0;
		padding: 1rem 1.25rem;
		font: 500 0.875rem/1.55 var(--font-body);
		color: var(--text-dim);
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		max-width: 68ch;
	}

	.install-strip {
		background: var(--bg-raised);
		border: 1px solid var(--line-strong);
		padding: 1.5rem clamp(1.25rem, 3vw, 2rem);
		border-radius: var(--r-md);
		box-shadow: var(--shadow-panel);
	}

	.install-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2rem;
		flex-wrap: wrap;
	}

	.install-cmd {
		font: 500 1rem/1 var(--font-mono);
		background: var(--bg-sunken);
		color: var(--accent);
		padding: 0.875rem 1.25rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		margin: 0;
	}

	.install-aside {
		max-width: 36ch;
	}

	.install-aside :global(pre) {
		margin: 0 0 0.5rem;
		font-size: 0.8125rem;
		color: var(--text-dim);
		background: transparent;
	}

	.install-aside :global(.caption) {
		color: var(--text-faint);
	}

	@media (max-width: 1023px) {
		.hero-grid,
		.what-grid {
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
</style>
