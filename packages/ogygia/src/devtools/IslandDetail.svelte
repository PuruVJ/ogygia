<script>
	/**
	 * The per-island detail view — "inspect element" for an ogygia region. Selecting a region (a Lens
	 * roster row, or picking it on the page) opens this over the tab body: one focused card that pulls
	 * together what the separate tabs each show a slice of — the region's identity, its full cost
	 * breakdown (JS-with-deps / entry chunk / props / server HTML), and its client LIFECYCLE as a
	 * mini-timeline (connected → scheduled → woke → hydrate → done, with per-phase offsets). A pure
	 * consumer of the DOM + bus, keyed by the selected `<ogygia-region>` element.
	 */
	import { parse } from 'devalue';
	import {
		region_info,
		region_name,
		region_transitive,
		chunk_bytes,
		latest_event,
		region_props_sidecar
	} from './regions.js';
	import { snapshot } from './bus.js';
	import PropsTree from './PropsTree.svelte';

	let { el, tick = 0, onclose } = $props();

	const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');

	// Every transportable crosses under ONE devalue custom type ('OgygiaRef'). Decode it to a labelled
	// placeholder — NOT the live instance (`wire.resolve` has side effects) — so the viewer stays inert.
	const REVIVERS = {
		OgygiaRef: (d) => ({ __ogRef: true, kind: d && d.k, id: d && d.i, tag: d && d.t })
	};
	function decode_props(text) {
		if (!text || text.length < 3) return null;
		try {
			const v = parse(text, REVIVERS);
			return v && typeof v === 'object' && Object.keys(v).length ? v : null;
		} catch {
			return null;
		}
	}

	// Client lifecycle phases, in order, with the Timeline's colours.
	const PHASES = [
		{ name: 'region.connected', label: 'connected', c: '#64748b' },
		{ name: 'wake.scheduled', label: 'scheduled', c: '#38bdf8' },
		{ name: 'wake.fired', label: 'woke', c: '#2dd4bf' },
		{ name: 'region.hydrate.start', label: 'hydrate', c: '#f59e0b' },
		{ name: 'region.hydrate.done', label: 'done', c: '#22c55e' },
		{ name: 'interaction.replay', label: 'replay', c: '#8b5cf6' }
	];

	const model = $derived.by(() => {
		tick;
		const info = region_info(el);
		const t = region_transitive(info.entry);
		const chunk = info.entry ? chunk_bytes(info.entry) : null;
		const ev = snapshot();
		const rendered = info.fp
			? latest_event((e) => e.name === 'server.region.rendered' && e.fp === info.fp)
			: null;
		const marks = [];
		for (const ph of PHASES) {
			const e = ev.find((x) => x.name === ph.name && x.fp === info.fp);
			if (e) marks.push({ ...ph, t: e.t });
		}
		marks.sort((a, b) => a.t - b.t);
		const t0 = marks.length ? marks[0].t : 0;
		const start = marks.find((m) => m.name === 'region.hydrate.start');
		const done = marks.find((m) => m.name === 'region.hydrate.done');
		const hydrateMs = start && done ? done.t - start.t : (rendered && rendered.ms) ?? null;
		return {
			info,
			name: region_name(info.entry),
			t,
			chunk,
			rendered,
			marks: marks.map((m) => ({ ...m, off: m.t - t0 })),
			hydrateMs,
			props: decode_props(region_props_sidecar(el))
		};
	});

	function locate() {
		try {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		} catch {
			/* detached */
		}
	}
</script>

<div class="detail" data-og-detail>
	<div class="bar">
		<button class="back" onclick={onclose} title="back to the roster">‹ back</button>
		<span class="dot {model.info.kind}"></span>
		<b class="name">{model.name}</b>
		<span class="k">{model.info.kind}{model.info.kind === 'island' ? ' · ' + model.info.wake : ''}</span>
		<button class="loc" onclick={locate}>scroll to it ›</button>
	</div>

	<div class="sec">lifecycle</div>
	{#if model.marks.length}
		<div class="life">
			{#each model.marks as m, i}
				{#if i > 0}<span class="arm"></span>{/if}
				<div class="ph" title="{m.name} @ +{m.off.toFixed(1)}ms">
					<span class="pd" style:background={m.c}></span><span class="pl">{m.label}</span>
					<span class="off">+{m.off.toFixed(1)}ms</span>
				</div>
			{/each}
		</div>
		{#if model.hydrateMs != null}
			<div class="hyd">hydrated in <b>{model.hydrateMs.toFixed(1)} ms</b></div>
		{/if}
	{:else}
		<div class="muted">
			{model.info.kind === 'island'
				? model.info.hydrated
					? 'hydrated (no timing captured this session)'
					: 'cold — has not woken yet'
				: 'no client lifecycle — pure server HTML'}
		</div>
	{/if}

	<div class="sec">cost</div>
	<div class="rows">
		{#if model.t}
			<div class="row"><span class="rk">js + deps</span><span class="v">{kb(model.t.bytes)}<span class="muted"> · {model.t.modules} mod</span></span></div>
		{/if}
		{#if model.chunk?.loaded}
			<div class="row"><span class="rk">entry chunk</span><span class="v">{kb(model.chunk.wire)}<span class="muted"> wire · {kb(model.chunk.raw)} raw</span></span></div>
		{/if}
		{#if model.rendered?.propsBytes != null}
			<div class="row"><span class="rk">props payload</span><span class="v">{model.rendered.propsBytes} B</span></div>
		{/if}
		{#if model.rendered?.htmlBytes != null}
			<div class="row"><span class="rk">server HTML</span><span class="v">{model.rendered.htmlBytes} B</span></div>
		{/if}
	</div>

	{#if model.props}
		<div class="sec">props <span class="secn">— the data that crossed the boundary</span></div>
		<div class="props" data-og-props>
			{#each Object.entries(model.props) as [k, v] (k)}
				<PropsTree value={v} name={k} />
			{/each}
		</div>
	{/if}

	<div class="sec">identity</div>
	<div class="rows">
		<div class="row"><span class="rk">mode</span><span class="v">{model.rendered?.mode ?? model.info.kind}</span></div>
		<div class="row"><span class="rk">state</span><span class="v">{model.info.kind === 'island' ? (model.info.hydrated ? 'hydrated' : 'cold') : model.info.hydrated ? 'filled' : 'pending'}</span></div>
		<div class="row"><span class="rk">server-rendered</span><span class="v">{model.rendered ? 'yes' : 'no'}</span></div>
		{#if model.info.fp}<div class="row"><span class="rk">fingerprint</span><span class="v mono">{model.info.fp}</span></div>{/if}
		{#if model.info.entry}<div class="row"><span class="rk">entry</span><span class="v mono" title={model.info.entry}>{model.info.entry.split('/').pop()}</span></div>{/if}
	</div>
</div>

<style>
	.detail {
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-bottom: 10px;
		margin-bottom: 4px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
	}
	.back {
		padding: 3px 9px;
		border-radius: 6px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		background: #0d1526;
		color: #94a3b8;
		cursor: pointer;
		font: inherit;
	}
	.back:hover {
		color: #e2e8f0;
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex: none;
	}
	.dot.island {
		background: #14b8a6;
	}
	.dot.lake {
		background: #f59e0b;
	}
	.dot.hole {
		background: #8b5cf6;
	}
	.name {
		color: #e2e8f0;
		font-size: 13px;
		font-weight: 700;
	}
	.k {
		color: #94a3b8;
	}
	.loc {
		margin-left: auto;
		padding: 3px 9px;
		border-radius: 6px;
		border: 1px solid rgba(94, 234, 212, 0.3);
		background: rgba(20, 184, 166, 0.12);
		color: #5eead4;
		cursor: pointer;
		font: inherit;
	}
	.sec {
		margin: 12px 0 6px;
		color: #94a3b8;
		font-weight: 600;
		text-transform: uppercase;
		font-size: 10px;
		letter-spacing: 0.04em;
	}
	.secn {
		text-transform: none;
		letter-spacing: 0;
		color: #64748b;
		font-weight: 400;
	}
	.props {
		padding: 8px 10px;
		border-radius: 8px;
		background: rgba(148, 163, 184, 0.06);
		border: 1px solid rgba(148, 163, 184, 0.14);
		max-height: 240px;
		overflow: auto;
	}
	.life {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ph {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.1);
	}
	.pd {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}
	.pl {
		color: #e2e8f0;
	}
	.off {
		color: #64748b;
		font-size: 10px;
	}
	.arm {
		width: 10px;
		height: 1px;
		background: rgba(148, 163, 184, 0.4);
	}
	.hyd {
		margin-top: 8px;
		color: #94a3b8;
	}
	.hyd b {
		color: #5eead4;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		padding: 2px 0;
	}
	.rk {
		color: #94a3b8;
	}
	.v {
		color: #e2e8f0;
	}
	.muted {
		color: #64748b;
	}
	.mono {
		color: #cbd5e1;
	}
</style>
