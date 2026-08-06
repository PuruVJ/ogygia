<script lang="ts">
	// Every island here calls a SvelteKit remote function on the client. ogygia reuses Kit's own
	// remote primitives and wire codec inside islands — this is real Kit remote code, not an imitation.
	import ResolvedGreeting from '$lib/playground/ResolvedGreeting.svelte' with { hydrate: 'load' };
	import RemoteCounter from '$lib/playground/RemoteCounter.svelte' with { hydrate: 'load' };
	import LiveClock from '$lib/playground/LiveClock.svelte' with { hydrate: 'load' };
	import BatchProbe from '$lib/playground/BatchProbe.svelte' with { hydrate: 'load' };
	import GuestbookForm from '$lib/playground/GuestbookForm.svelte' with { hydrate: 'load' };
	import PageHead from '$lib/PageHead.svelte';
</script>

<PageHead
	title="Data & remotes · Playground"
	description="SvelteKit remote functions inside ogygia islands — query, command, live SSE, batch, and remote form()."
/>

<main class="shell docs-main">
	<section id="data">
		<span class="eyebrow">.remote.ts</span>
		<div class="section-header">
			<h2>Data &amp; remote functions</h2>
			<p class="section-lede">
				Server data reaches the shell as props; interactivity talks back through Kit's remote
				functions. Each primitive below runs inside its own island.
			</p>
		</div>

		<div class="pg-cols">
			<div class="strategy">
				<h3><code>query</code> — seeded from SSR</h3>
				<div class="prose">
					<p>
						Awaited outside a pending boundary, so it resolves during SSR. In a production build
						the result is seeded into the client cache and hydration adopts the on-screen HTML with
						no re-fetch. (Under <code>vite dev</code> the seed can't cross module isolation, so dev
						re-fetches — cosmetic, documented.)
					</p>
				</div>
				<ResolvedGreeting name="world" />
			</div>

			<div class="strategy">
				<h3><code>command</code> + <code>query.refresh()</code></h3>
				<div class="prose">
					<p>
						The counter reads a server value with <code>query</code>. Bump runs a
						<code>command</code> to mutate server state, then <code>.refresh()</code> re-reads it —
						all from inside the island.
					</p>
				</div>
				<RemoteCounter />
			</div>

			<div class="strategy">
				<h3><code>query.live</code> — SSE stream</h3>
				<div class="prose">
					<p>
						A streaming server clock over Server-Sent Events. The reactive
						<code>.current</code> updates each tick after hydration. This one keeps a connection
						open on purpose.
					</p>
				</div>
				<LiveClock />
			</div>

			<div class="strategy">
				<h3><code>query.batch</code></h3>
				<div class="prose">
					<p>
						Three <code>getSquare()</code> calls fired in the same tick collapse into one request.
						A shared <code>batchAt</code> across all three results proves a single server run.
					</p>
				</div>
				<BatchProbe />
			</div>

			<div class="strategy pg-col-wide">
				<h3><code>form()</code> — remote guestbook</h3>
				<div class="prose">
					<p>
						A remote <code>form()</code> inside an island: enhanced submit with no reload, per-field
						validation issues, and pending state — all from Kit's own form runtime. With JavaScript
						off it posts natively to the remote endpoint and post-redirect-gets back. The store is
						in-memory (resets on restart), ring-capped at 48 entries; the UI shows the latest 8.
					</p>
				</div>
				<GuestbookForm />
			</div>
		</div>
	</section>
</main>

<style>
	.pg-cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 2.5rem 2rem;
	}
	.pg-col-wide {
		grid-column: 1 / -1;
	}
</style>
