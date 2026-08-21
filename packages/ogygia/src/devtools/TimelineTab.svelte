<script>
	/**
	 * The Timeline tab: CLIENT-realm events on a time axis, one lane per region (+ a page/nav lane), a
	 * hydrate.start→done bar per region. Server events are excluded on purpose — their clock is a
	 * different origin. The track width follows the window (bind:clientWidth), so it never overflows.
	 */
	import { snapshot } from './bus.js';

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
		let t0 = Infinity;
		let t1 = -Infinity;
		for (const e of events) {
			if (e.t < t0) t0 = e.t;
			if (e.t > t1) t1 = e.t;
		}
		const span = Math.max(1, t1 - t0);
		const x = (t) => ((t - t0) / span) * trackW;

		const laneMap = new Map();
		laneMap.set('page', []);
		for (const e of events) {
			const key = e.fp || 'page';
			if (!laneMap.has(key)) laneMap.set(key, []);
			laneMap.get(key).push(e);
		}
		const lanes = [];
		for (const [key, evs] of laneMap) {
			if (evs.length === 0) continue;
			const withEntry = evs.find((e) => e.entry);
			const label =
				key === 'page'
					? 'page / nav'
					: (withEntry?.entry ? withEntry.entry.split('/').pop().replace(/\.js$/, '') : key.slice(0, 10)).slice(0, 20);
			const start = evs.find((e) => e.name === 'region.hydrate.start');
			const done = evs.find((e) => e.name === 'region.hydrate.done');
			const bar = start && done ? { left: x(start.t), width: Math.max(2, x(done.t) - x(start.t)) } : null;
			const dots = evs.map((e) => ({
				left: x(e.t),
				color: MARK[e.name].c,
				title: `${MARK[e.name].t} · ${e.name} @ +${(e.t - t0).toFixed(1)}ms`
			}));
			lanes.push({ key, label, bar, dots });
		}
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
					{#if lane.bar}<div class="bar" style:left="{lane.bar.left}px" style:width="{lane.bar.width}px"></div>{/if}
					{#each lane.dots as d}<div class="dot" title={d.title} style:left="{d.left}px" style:background={d.color}></div>{/each}
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
		top: 8px;
		height: 4px;
		border-radius: 2px;
		background: rgba(34, 197, 94, 0.45);
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
