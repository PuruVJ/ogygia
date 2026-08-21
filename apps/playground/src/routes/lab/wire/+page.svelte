<script lang="ts">
	// Cross-island serialization: ONE transportable class instance (import.meta.og.wire) is provided
	// to the page; three SEPARATE island bundles read it from context. On a csr=false page each island
	// hydrates as its own root, yet the wire-encoded object is revived to the SAME live instance in all
	// of them — mutate it in the writer and every reader repaints (same heap, not copies).
	import { Provide } from 'ogygia';
	import CtxWriter from '$lib/CtxWriter.svelte' with { wake: 'load' };
	import CtxReader from '$lib/CtxReader.svelte' with { wake: 'load' };
	import { SharedCounter } from '$lib/counter-object.svelte.js';
	import { roomCtx } from '$lib/room-context.svelte.js';

	const counter = new SharedCounter('lab', 7);
</script>

<h1>Cross-island serialization</h1>
<p>
	A <code>SharedCounter</code> (a real class with a <code>$state</code> field and a <code>double</code>
	getter) is provided once. The writer and the two readers are independent island bundles. The class
	crosses the boundary as its <code>og.wire</code> encoding and is decoded back to one live instance.
</p>

<Provide values={[roomCtx(counter)]}>
	<div class="wire-grid">
		<div>
			<h3>writer island</h3>
			<CtxWriter />
		</div>
		<div>
			<h3>reader island 1</h3>
			<CtxReader label="reader-1" />
		</div>
		<div>
			<h3>reader island 2</h3>
			<CtxReader label="reader-2" />
		</div>
	</div>
</Provide>

<p class="hint">
	Each reader shows <b>count</b> then <b>double</b>. Click <b>inc</b> in the writer — both readers
	jump together (7→8→9…, double = 14→16→18…). <code>data-is-instance="true"</code> on every island
	means the live object was revived, not a snapshot.
</p>

<style>
	.wire-grid {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
		margin: 12px 0;
	}
	.wire-grid h3 {
		font-size: 0.9rem;
		margin: 0 0 4px;
		color: #475569;
	}
	:global([data-ctx-reader]) {
		font-size: 1.4rem;
		font-variant-numeric: tabular-nums;
	}
	.hint {
		background: #f1f5f9;
		border-radius: 8px;
		padding: 10px 14px;
	}
	code {
		background: #eef2ff;
		padding: 1px 5px;
		border-radius: 4px;
	}
</style>
