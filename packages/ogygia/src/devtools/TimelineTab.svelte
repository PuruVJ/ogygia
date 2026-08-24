<script>
	/**
	 * The Timeline tab: CLIENT-realm events on a time axis, one lane per region (+ a page/nav lane), a
	 * hydrate.start→done bar per region. Server events are excluded on purpose — their clock is a
	 * different origin. The track width follows the window (bind:clientWidth), so it never overflows.
	 */
	import { snapshot } from './bus.js';
	import { region_name, region_name_by_fp } from './regions.js';

	let { tick = 0 } = $props();

	const MARK = {
		'runtime.boot': { c: '#64748b', t: 'boot' },
		'region.connected': { c: '#64748b', t: 'connect' },
		'wake.scheduled': { c: '#38bdf8', t: 'sched' },
		'wake.fired': { c: '#2dd4bf', t: 'wake' },
		'region.hydrate.start': { c: '#f59e0b', t: 'hydrate' },
		'region.hydrate.done': { c: '#22c55e', t: 'done' },
		'region.hydrate.failed': { c: '#ef4444', t: 'fail' },
		'interaction.replay': { c: '#8b5cf6', t: 'replay' },
		'nav.start': { c: '#ec4899', t: 'nav' },
		'nav.finish': { c: '#ec4899', t: 'nav done' }
	};
	const LEGEND = ['wake.scheduled', 'wake.fired', 'region.hydrate.start', 'region.hydrate.done', 'interaction.replay', 'nav.start'];
	const LABEL_W = 118;

	let wrapW = $state(560);
	const trackW = $derived(Math.max(200, wrapW - LABEL_W - 12));

	const model = $derived.by(() => {
		tick; // refresh with the panel tick
		const events = snapshot().filter((e) => e.realm === 'client' && MARK[e.name]);
		if (events.length === 0) return { events: [], lanes: [], span: 0 };

		// Group by region, keeping only the FIRST occurrence of each phase. A live region re-emits
		// wake/hydrate on every tick — folding to first-per-phase keeps a 2-minute live tail from
		// stretching the axis so the real initial-load hydrations collapse into a single dot.
		const laneMap = new Map();
		for (const e of events) {
			const key = e.fp || 'page';
			let lane = laneMap.get(key);
			if (!lane) laneMap.set(key, (lane = { key, first: new Map(), entry: null }));
			if (!lane.first.has(e.name)) lane.first.set(e.name, e);
			if (e.entry && !lane.entry) lane.entry = e.entry;
		}

		// Axis spans only those first events — i.e. the initial hydration wave.
		let t0 = Infinity;
		let t1 = -Infinity;
		for (const lane of laneMap.values())
			for (const e of lane.first.values()) {
				if (e.t < t0) t0 = e.t;
				if (e.t > t1) t1 = e.t;
			}
		const span = Math.max(1, t1 - t0);
		const x = (t) => ((t - t0) / span) * trackW;

		const lanes = [];
		for (const lane of laneMap.values()) {
			const evs = [...lane.first.values()].sort((a, b) => a.t - b.t);
			const label =
				lane.key === 'page'
					? 'page / nav'
					: lane.entry
						? region_name(lane.entry)
						: region_name_by_fp(lane.key);
			// Bar = schedule → done (or the earliest phase we saw → done). Open bar when hydrate hasn't
			// finished yet, so a still-waking region reads differently from a done one.
			const start =
				lane.first.get('wake.scheduled') ||
				lane.first.get('wake.fired') ||
				lane.first.get('region.hydrate.start');
			const done =
				lane.first.get('region.hydrate.done') || lane.first.get('region.hydrate.failed');
			const bar = start
				? {
						left: x(start.t),
						width: done ? Math.max(3, x(done.t) - x(start.t)) : Math.max(3, trackW - x(start.t)),
						open: !done,
						failed: lane.first.has('region.hydrate.failed')
					}
				: null;
			const dur = start && done ? done.t - start.t : null;
			const dots = evs.map((e) => ({
				left: x(e.t),
				color: MARK[e.name].c,
				title: `${MARK[e.name].t} · ${e.name} @ +${(e.t - t0).toFixed(1)}ms`
			}));
			lanes.push({ key: lane.key, label, bar, dots, dur, order: evs[0]?.t ?? 0 });
		}
		lanes.sort((a, b) => a.order - b.order);
		return { events, lanes, span };
	});
</script>

<h4>timeline — client wake / hydrate {model.events.length ? `(${model.events.length} events)` : ''}</h4>

{#if model.events.length === 0}
	<div class="muted">no client events yet — interact with the page, then reopen.</div>
{:else}
	<div class="wrap" bind:clientWidth={wrapW}>
		{#each model.lanes as lane (lane.key)}
			<div class="lane">
				<div class="label" title={lane.key} style:width="{LABEL_W}px">{lane.label}</div>
				<div class="track" style:width="{trackW}px">
					{#if lane.bar}
						<div
							class="bar"
							class:open={lane.bar.open}
							class:failed={lane.bar.failed}
							style:left="{lane.bar.left}px"
							style:width="{lane.bar.width}px"
						></div>
					{/if}
					{#each lane.dots as d}<div class="dot" title={d.title} style:left="{d.left}px" style:background={d.color}></div>{/each}
					{#if lane.dur != null}<span class="dur" style:left="{(lane.bar?.left ?? 0) + (lane.bar?.width ?? 0)}px">{lane.dur < 10 ? lane.dur.toFixed(1) : Math.round(lane.dur)} ms</span>{/if}
				</div>
			</div>
		{/each}
		<div class="lane axis">
			<div class="label" style:width="{LABEL_W}px"></div>
			<div class="track" style:width="{trackW}px">
				<span class="l">0 ms</span><span class="r">{model.span.toFixed(model.span < 100 ? 1 : 0)} ms total</span>
			</div>
		</div>
	</div>

	<div class="legend">
		{#each LEGEND as n}
			<span class="li"><span class="dot inline" style:background={MARK[n].c}></span>{MARK[n].t}</span>
		{/each}
	</div>
{/if}

<style>
	h4 {
		margin: 0 0 8px;
		font-size: 12px;
		color: #5eead4;
	}
	.muted {
		color: #64748b;
	}
	.wrap {
		width: 100%;
	}
	.lane {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 3px 0;
	}
	.label {
		color: #64748b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.track {
		position: relative;
		height: 18px;
		border-left: 1px solid rgba(148, 163, 184, 0.25);
	}
	.bar {
		position: absolute;
		top: 7px;
		height: 5px;
		border-radius: 3px;
		background: linear-gradient(90deg, rgba(56, 189, 248, 0.5), rgba(34, 197, 94, 0.6));
	}
	.bar.open {
		background: repeating-linear-gradient(
			90deg,
			rgba(245, 158, 11, 0.5),
			rgba(245, 158, 11, 0.5) 4px,
			transparent 4px,
			transparent 8px
		);
	}
	.bar.failed {
		background: rgba(239, 68, 68, 0.6);
	}
	.dur {
		position: absolute;
		top: 3px;
		margin-left: 5px;
		font-size: 10px;
		color: #94a3b8;
		white-space: nowrap;
	}
	.dot {
		position: absolute;
		top: 5px;
		width: 9px;
		height: 9px;
		margin-left: -4px;
		border-radius: 50%;
		border: 1px solid #0b1220;
	}
	.axis .track {
		height: 14px;
		border-left: none;
	}
	.axis .l {
		position: absolute;
		left: 0;
		color: #64748b;
	}
	.axis .r {
		position: absolute;
		right: 0;
		color: #64748b;
	}
	.legend {
		margin-top: 10px;
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.li {
		color: #64748b;
	}
	.dot.inline {
		position: static;
		display: inline-block;
		margin: 0 5px 0 0;
		vertical-align: 0;
		border: none;
	}
</style>
