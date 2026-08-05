<script lang="ts">
	// Server islands: the `defer` value is the FETCH TIMING for the hole, symmetric with `hydrate`.
	// The same module is imported four times, once per schedule. Only `load` emits a preload hint;
	// `visible` does not hit the network until the hole scrolls into view.
	import GLoad from '$lib/demos/ServerGreeting.svelte' with { defer: 'load' };
	import GIdle from '$lib/demos/ServerGreeting.svelte' with { defer: 'idle' };
	import GMedia from '$lib/demos/ServerGreeting.svelte' with { defer: '(min-width: 300px)' };
	import GVisible from '$lib/demos/ServerGreeting.svelte' with { defer: 'visible' };

	// Cookie personalization: a deferred island that reads a cookie during its server render, plus a
	// tiny client island to set that cookie.
	import CookieGreeting from '$lib/playground/CookieGreeting.svelte' with { defer: 'load' };
	import CookieSetter from '$lib/playground/CookieSetter.svelte' with { hydrate: 'load' };
</script>

<main class="shell docs-main">
	<section id="server-islands">
		<span class="eyebrow">defer</span>
		<div class="section-header">
			<h2>Server islands</h2>
			<p class="section-lede">
				A deferred island renders its <code>fallback</code> into the page immediately, then the
				browser fetches the real HTML from a signed, same-origin endpoint. Zero component JS ships.
				Each hole below fetches on a different schedule.
			</p>
		</div>

		<div class="section-stack demo-section">
			<div class="strategy">
				<h3><code>defer: 'load'</code></h3>
				<div class="prose">
					<p>
						Fetches immediately on connect and is the only timing that emits a
						<code>&lt;link rel="preload" as="fetch"&gt;</code> hint, which the runtime reuses so
						there is one server render.
					</p>
				</div>
				<div class="pg-hole" data-defer="load">
					<GLoad salutation="Loaded">
						{#snippet fallback()}<p class="pg-fallback" data-fallback-load>fetching…</p>{/snippet}
					</GLoad>
				</div>
			</div>

			<div class="strategy">
				<h3><code>defer: 'idle'</code></h3>
				<div class="prose">
					<p>Waits for <code>requestIdleCallback</code> before fetching. No preload hint.</p>
				</div>
				<div class="pg-hole" data-defer="idle">
					<GIdle salutation="Idle">
						{#snippet fallback()}<p class="pg-fallback" data-fallback-idle>fetching…</p>{/snippet}
					</GIdle>
				</div>
			</div>

			<div class="strategy">
				<h3><code>defer: '(min-width: 300px)'</code></h3>
				<div class="prose">
					<p>Fetches when the media query matches. On any normal window this matches at once.</p>
				</div>
				<div class="pg-hole" data-defer="media">
					<GMedia salutation="Matched">
						{#snippet fallback()}<p class="pg-fallback" data-fallback-media>fetching…</p>{/snippet}
					</GMedia>
				</div>
			</div>

			<div class="strategy" id="cookie">
				<h3>Cookie personalization</h3>
				<div class="prose">
					<p>
						The greeting below is a deferred server island. During its render on the endpoint it
						reads your <code>pg_name</code> cookie (defaulting to <em>voyager</em>) — cookies flow
						because the fetch is same-origin. Set a name and reload: the island re-renders with it.
						No component JS ships for the greeting.
					</p>
				</div>
				<div class="pg-cookie">
					<div class="pg-hole" data-cookie-hole>
						<CookieGreeting>
							{#snippet fallback()}<p class="pg-fallback" data-fallback-cookie>reading cookie…</p>{/snippet}
						</CookieGreeting>
					</div>
					<CookieSetter />
				</div>
			</div>

			<div class="strategy">
				<h3><code>defer: 'visible'</code> — below the fold</h3>
				<div class="prose">
					<p>
						This hole does not fetch until it scrolls into view. The server does no work for
						content nobody reached. Scroll down past the spacer to trigger it.
					</p>
				</div>
				<div class="pg-spacer" aria-hidden="true">keep scrolling…</div>
				<div class="pg-hole" data-defer="visible">
					<GVisible salutation="Visible">
						{#snippet fallback()}<p class="pg-fallback" data-fallback-visible>fetching…</p>{/snippet}
					</GVisible>
				</div>
			</div>
		</div>
	</section>
</main>

<style>
	.pg-hole {
		display: grid;
		place-items: start;
	}
	.pg-fallback {
		margin: 0;
		padding: 0.75rem 1rem;
		border: 1px dashed var(--line-strong);
		border-radius: var(--r-sm);
		color: var(--text-faint);
		font: 400 0.8125rem/1.4 var(--font-mono);
	}
	.pg-cookie {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
		align-items: flex-start;
	}
	.pg-spacer {
		height: 90vh;
		display: grid;
		place-items: center;
		margin: 1rem 0;
		border: 1px dashed var(--line);
		border-radius: var(--r-md);
		color: var(--text-faint);
		font: 400 0.8125rem/1 var(--font-mono);
	}
</style>
