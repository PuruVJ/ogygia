<script lang="ts">
	// Cross-island context matrix (csr=false page). One live counter is provided to a subtree; many
	// islands read it via get() with different hydration strategies, at different depths, alongside a
	// plain-value context, a defaulted context, a shadowing inner provider, and a transportable prop.
	import { Context } from 'ogygia';
	import CtxWriter from '$lib/CtxWriter.svelte' with { wake: 'load' };
	import CtxReader from '$lib/CtxReader.svelte' with { wake: 'load' };
	import CtxReaderIdle from '$lib/CtxReader.svelte' with { wake: 'idle' };
	import CtxReaderVisible from '$lib/CtxReader.svelte' with { wake: 'visible' };
	// Deferred CLIENT island: fetched from the endpoint, then hydrated → client get() joins context.
	import CtxReaderDeferHydrate from '$lib/CtxReader.svelte' with { fill: 'load', wake: 'load' };
	// Pure SERVER island: rendered in isolation on the endpoint (no page provider) and NOT hydrated →
	// it can only ever see the context default. Documents the server-island isolation boundary.
	import CtxReaderServer from '$lib/CtxReader.svelte' with { fill: 'load' };
	import CtxNestOuter from '$lib/CtxNestOuter.svelte' with { wake: 'load' };
	import CtxCoexist from '$lib/CtxCoexist.svelte' with { wake: 'load' };
	import ThemeReader from '$lib/ThemeReader.svelte' with { wake: 'load' };
	import OrphanReader from '$lib/OrphanReader.svelte' with { wake: 'load' };
	import { SharedCounter } from '$lib/counter-object.svelte.js';
	import { roomCtx, themeCtx } from '$lib/room-context.svelte.js';

	const counter = new SharedCounter('room', 5);
	const inner = new SharedCounter('inner', 99);
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Cross-island context matrix</h1>

<Context of={roomCtx} value={counter}>
	<section data-live-share>
		<h2 data-static-shell>Live share across strategies</h2>
		<!-- One writer, readers hydrating on load / idle / visible / defer — all reunite to one live
		     instance and repaint when the writer mutates it. -->
		<CtxWriter />
		<CtxReader label="load" />
		<CtxReaderIdle label="idle" />
		<!-- defer + hydrate → joins the live instance on the client -->
		<CtxReaderDeferHydrate label="defer-hydrate" />
		<!-- pure server island → isolated endpoint render, sees only the default -->
		<CtxReaderServer label="server" />

		<!-- Nested island: inner reader degrades + hydrates with the outer island -->
		<CtxNestOuter />

		<!-- Same counter as a prop AND via context → must be the same live instance -->
		<CtxCoexist {counter} />
	</section>

	<!-- visible reader sits far down so it hydrates only after a scroll (late join) -->
	<div style="height: 1400px"></div>
	<section data-late>
		<CtxReaderVisible label="visible" />
	</section>

	<!-- Inner provider shadows the outer for roomCtx: this reader must see 99, not 5 -->
	<section data-shadow>
		<h2 data-static-shell>Nested provider (nearest wins)</h2>
		<CtxReader label="outer-scope" />
		<Context of={roomCtx} value={inner}>
			<CtxReader label="inner-scope" />
		</Context>
	</section>

	<!-- Plain-value context: provided 'dark' here; a reader OUTSIDE this provider gets the default -->
	<section data-theme>
		<h2 data-static-shell>Plain value + default</h2>
		<Context of={themeCtx} value={'dark'}>
			<ThemeReader label="provided" />
		</Context>
		<ThemeReader label="defaulted" />
		<OrphanReader />
	</section>
</Context>

<style>
	/* Each island's <ogygia-region> is inline by default; make them block-level with spacing so
	   readers never overlap the writer button (otherwise Playwright clicks get intercepted). */
	:global(ogygia-region) {
		display: block;
		margin: 6px 0;
	}
	section {
		margin: 1.5rem 0;
	}
</style>
