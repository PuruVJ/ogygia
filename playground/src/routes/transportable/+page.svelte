<script lang="ts">
	// A live object crossing the boundary: the PAGE (server, csr=false) constructs the
	// instance and passes it to TWO separate islands as a normal prop. The codec ships it,
	// the client registry reunites both decodes into ONE live instance.
	import TransportWriter from '$lib/TransportWriter.svelte' with { wake: 'load' };
	import TransportReader from '$lib/TransportReader.svelte' with { wake: 'load' };
	// Transportable prop into a SERVER island (defer only): endpoint payload carries the wire codec.
	import TransportServer from '$lib/TransportServerReader.svelte' with { fill: 'load' };
	// Transportable prop into a deferred CLIENT island (defer+hydrate): props-sibling carries it too,
	// and after hydration it reunites into the one live instance.
	import TransportDeferHydrate from '$lib/TransportServerReader.svelte' with { fill: 'load', wake: 'load' };
	import WidgetStore from '$lib/WidgetStore.svelte' with { wake: 'load' };
	import WidgetReader from '$lib/WidgetReader.svelte' with { wake: 'load' };
	import { SharedCounter } from '$lib/counter-object.svelte.js';
	import { AliasProbe } from '$lib/alias-probe.svelte.js';
	import { WidgetStore as WidgetStoreClass } from '$lib/WidgetStore.svelte';

	const counter = new SharedCounter('demo', 5);
	const probe = new AliasProbe('alias-ok');
	const store = new WidgetStoreClass('gadget', 3);
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Transportable live object</h1>
<p data-static-shell>
	One <code>new SharedCounter('demo', 5)</code> made on the server, passed to two islands as a
	prop. Server-seeded (renders 5, no flicker), then live across both islands.
</p>

<TransportWriter {counter} {probe} />
<TransportReader {counter} />

<h2 data-static-shell>Transportable prop into a server island</h2>
<p data-static-shell>
	The same counter handed to a <code>defer</code> server island (endpoint-rendered) and a
	<code>defer</code>+<code>hydrate</code> client island. Both must decode the live object.
</p>
<div data-transport-server-wrap><TransportServer counter={counter} label="server" /></div>
<div data-transport-dh-wrap><TransportDeferHydrate counter={counter} label="defer-hydrate" /></div>

<h2 data-static-shell>Class in a component's &lt;script module&gt;</h2>
<WidgetStore {store} />
<WidgetReader {store} />
