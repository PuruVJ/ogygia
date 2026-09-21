<script lang="ts">
	/**
	 * THE CRITICAL PATH of one render (timeline.ts), a `wake:'load'` island: a bar of the request's
	 * window, coalesced so it reads (a run of small slivers is one block named after what dominated
	 * it), with a real hover tooltip and click-to-step; the phase split; then the numbered steps
	 * that set the wall time, with the "awaits in a row" callouts. Solid = CPU, coloured by owner;
	 * striped = waiting; dark = nothing recorded.
	 */
	import { chain_steps, coalesce, PHASE_LABEL, type Timeline, type ViewSegment } from '../timeline.js';
	import { fmt_ms, CATEGORY_COLOR, CATEGORY_LABEL } from './format.js';

	let {
		t,
		gc = []
	}: {
		t: Timeline;
		/** the GC pauses inside this window, on the window's clock, with what caused each */
		gc?: { t: number; ms: number; kind: string; why: string; top: string }[];
	} = $props();
	const gc_in = $derived(gc.filter((p) => p.t >= 0 && p.t <= t.window_ms));

	const WAIT = '#5b8fd6';
	const IO = '#d9a03d';
	const GAP = '#2a2f38';
	const is_http = (s: ViewSegment) => !!s.calls?.some((c) => /^[A-Z]+ /.test(c.label));
	const fill = (s: ViewSegment) =>
		s.kind === 'cpu'
			? CATEGORY_COLOR[s.category] || '#6b7280'
			: s.kind === 'wait'
				? `repeating-linear-gradient(135deg, ${is_http(s) ? WAIT : IO} 0 4px, #0d1014 4px 6px)`
				: GAP;
	const dot = (s: ViewSegment) => (s.kind === 'cpu' ? CATEGORY_COLOR[s.category] || '#6b7280' : s.kind === 'wait' ? (is_http(s) ? WAIT : IO) : GAP);

	const view = coalesce(t);
	const steps = chain_steps(t);
	const step_index = new Map(steps.map((s) => [s.i, s]));
	const phase_total = t.phases.reduce((s, p) => s + p.cpu_ms + p.wait_ms, 0) || 1;
	const saves = t.parallelizable.filter((g) => g.save_ms >= 1);
	// a save callout sits on the first block of its group (`at` indexes the same coalesced view);
	// a chain of calls each too small to be a step (an N+1 loop) gets its callout after the list
	const save_at = new Map<number, (typeof saves)[number]>();
	for (const g of saves) if (step_index.has(g.at[0]) && !save_at.has(g.at[0])) save_at.set(g.at[0], g);
	const orphan_saves = saves.filter((g) => !step_index.has(g.at[0]) && g.save_ms >= Math.max(2, t.window_ms * 0.02));
	const chain_label = (calls: string[]) =>
		calls.length <= 4 ? calls.join(' → ') : `${calls[0]} → ${calls[1]} → … → ${calls[calls.length - 1]} (${calls.length} calls)`;

	let tip = $state<{ i: number; x: number; y: number } | null>(null);
	let picked = $state<number | null>(null);
	const pct = (s: ViewSegment) => ((s.t1 - s.t0) / t.window_ms) * 100;

	function pick(i: number) {
		picked = i;
		const step = step_index.get(i);
		if (step) document.getElementById(`tl-step-${i}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}
</script>

<div class="legend">
	<span><i style="background:{CATEGORY_COLOR.component}"></i> component</span>
	<span><i style="background:{CATEGORY_COLOR.app}"></i> your code</span>
	<span><i style="background:{CATEGORY_COLOR.dependency}"></i> dependency</span>
	<span><i style="background:{CATEGORY_COLOR.svelte}"></i> svelte</span>
	<span><i style="background:{CATEGORY_COLOR.node}"></i> node</span>
	<span><i class="stripe" style="--c:{WAIT}"></i> waiting on a call</span>
	<span><i class="stripe" style="--c:{IO}"></i> waiting on a timer / file / socket</span>
	<span><i style="background:{GAP}"></i> nothing recorded</span>
	<span class="hint">solid = the CPU was running that · striped = the server was waiting · hover a block, click it to jump to its step</span>
</div>

<div class="bar" role="img" aria-label="the render, start to end" onmouseleave={() => (tip = null)}>
	{#each view as s, i (i)}
		<div
			class="seg {s.kind}"
			class:picked={picked === i}
			style="width:{Math.max(pct(s), 0.2)}%;background:{fill(s)}"
			onmouseenter={(e) => (tip = { i, x: e.clientX, y: e.clientY })}
			onmousemove={(e) => (tip = { i, x: e.clientX, y: e.clientY })}
			onclick={() => pick(i)}
			role="button"
			tabindex="-1"
		>
			{#if pct(s) > 5}<span>{s.kind === 'wait' ? 'wait: ' : ''}{s.label}</span>{/if}
		</div>
	{/each}
</div>
{#if gc_in.length}
	<div class="gc-row" role="img" aria-label="GC pauses in this render">
		{#each gc_in as p, i (i)}
			<i class="gc-tick {p.kind}" style="left:{(p.t / t.window_ms) * 100}%;width:{Math.max((p.ms / t.window_ms) * 100, 0.25)}%" title="GC {p.kind} · {fmt_ms(p.ms)} ms at {fmt_ms(p.t)} ms — {p.why}{p.top ? `. Mostly: ${p.top}` : ''}"></i>
		{/each}
		<span class="gc-label hint">GC pauses ({gc_in.length}) — hover one for what filled the heap before it</span>
	</div>
{/if}
<div class="axis">
	<span>0 ms</span><span>{fmt_ms(t.window_ms / 2)} ms</span><span>{fmt_ms(t.window_ms)} ms</span>
</div>
{#if tip}
	{@const s = view[tip.i]}
	<div class="tip" style="left:{Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 380)}px;top:{tip.y + 16}px">
		<div class="tip-h">
			<i style="background:{dot(s)}"></i>
			<b>{fmt_ms(s.t1 - s.t0)} ms</b> · {pct(s).toFixed(1)}% · from {fmt_ms(s.t0)} to {fmt_ms(s.t1)} ms
		</div>
		{#if s.within}<div class="dim">inside span <b>{s.within}</b></div>{/if}
		{#if s.kind === 'cpu'}
			<div>on the CPU: <b>{s.label}</b>{#if s.detail} — mostly {s.detail}{/if}</div>
			{#if s.file}<div class="mono">{s.file}</div>{/if}
			<div class="dim">{CATEGORY_LABEL[s.category]} · {PHASE_LABEL[s.phase]}</div>
		{:else if s.kind === 'wait'}
			<div>waiting on {s.calls && s.calls.length > 1 ? `${s.calls.length} calls at once` : 'one call'} · {PHASE_LABEL[s.phase]}</div>
			{#each (s.calls ?? []).slice(0, 8) as c (c.label)}
				<div class="mono">{c.label} <span class="dim">{fmt_ms(c.ms)} ms{c.caller ? ` · from ${c.caller}` : ''}</span></div>
				{#if c.callers && c.callers.length > 1}
					<div class="mono dim">  call path: {c.callers.join(' ← ')}</div>
				{/if}
				{#if c.timings?.length}
					<div class="mono dim">  their side: {c.timings.map((t) => `${t.desc ?? t.name} ${fmt_ms(t.ms)} ms`).join(' · ')}</div>
				{/if}
			{/each}
		{:else}
			<div>nothing recorded — a promise chain, a driver on its own socket, a worker</div>
			{#if s.pending?.length}
				<div class="dim">pending across it:</div>
				{#each s.pending as p (p)}<div class="mono dim">{p}</div>{/each}
			{/if}
		{/if}
		{#if s.inside && s.inside.length > 1}
			<div class="dim" style="margin-top:4px">{s.parts} small pieces folded in:</div>
			{#each s.inside.slice(0, 6) as p (p.kind + p.label)}
				<div class="mono dim">{p.kind === 'wait' ? 'wait ' : ''}{p.label} {fmt_ms(p.ms)} ms</div>
			{/each}
		{/if}
	</div>
{/if}
<p class="hint totals">
	<b>{fmt_ms(t.window_ms)} ms</b> wall · {fmt_ms(t.cpu_ms)} ms on the CPU · {fmt_ms(t.wait_ms)} ms waiting on calls
	{#if t.gap_ms >= 0.5}· {fmt_ms(t.gap_ms)} ms unaccounted{/if}
</p>

{#if t.lanes?.length}
	<h3>Load functions <span class="hint">each lane is one Kit load: when it ran, on this render's clock</span></h3>
	<div class="lanes">
		{#each t.lanes as l (l.file)}
			<div class="lane" class:chained={t.chain && (t.chain.page === l.file || t.chain.layout === l.file)}>
				<span class="lname" title={l.file}>
					<code>{l.file.replace(/^routes\//, '')}</code>
					<span class="kind" class:universal={l.kind === 'universal'}>{l.kind}</span>
					{#if l.awaited_parent}<span class="kind parent" title="Kit's parent() ran under this load">await parent()</span>{/if}
				</span>
				<div class="ltrack" title="from {fmt_ms(l.t0)} to {fmt_ms(l.t1)} ms">
					<div class="lbar" style="left:{(l.t0 / t.window_ms) * 100}%;width:{Math.max(0.4, ((l.t1 - l.t0) / t.window_ms) * 100)}%">
						<div class="lcpu" style="width:{l.t1 > l.t0 ? Math.min(100, (l.cpu_ms / (l.t1 - l.t0)) * 100) : 0}%"></div>
					</div>
				</div>
				<span class="num">{fmt_ms(l.t0)}–{fmt_ms(l.t1)} ms <span class="hint">· {fmt_ms(l.cpu_ms)} ms CPU{l.wait_ms >= 0.5 ? ` + ${fmt_ms(l.wait_ms)} ms waiting` : ''}</span></span>
			</div>
		{/each}
	</div>
	{#if t.chain}
		<div class="save chain">
			<b>{t.chain.page.replace(/^routes\//, '')}</b> started only after <b>{t.chain.layout.replace(/^routes\//, '')}</b> finished, {fmt_ms(t.chain.serial_ms)} ms in
			{#if t.chain.explicit}— it awaits <code>parent()</code>.{:else}— Kit runs a page load and its layouts together unless the page awaits <code>parent()</code>.{/if}
			Start the page's own fetches first and await <code>parent()</code> after, and the two overlap: <b>up to {fmt_ms(t.chain.serial_ms)} ms back</b>.
		</div>
	{/if}
{/if}

<h3>Phases <span class="hint">where in the request the time sat</span></h3>
<div class="phases">
	{#each t.phases as p (p.phase)}
		<div class="prow">
			<span class="name">{PHASE_LABEL[p.phase]}</span>
			<div class="track">
				<div class="cpu" style="width:{(p.cpu_ms / phase_total) * 100}%" title="CPU {fmt_ms(p.cpu_ms)} ms"></div>
				<div class="wait" style="width:{(p.wait_ms / phase_total) * 100}%" title="waiting {fmt_ms(p.wait_ms)} ms"></div>
			</div>
			<span class="num">{fmt_ms(p.cpu_ms)} ms CPU{#if p.wait_ms >= 0.5} <span class="hint">+ {fmt_ms(p.wait_ms)} ms waiting</span>{/if}</span>
		</div>
	{/each}
</div>

<h3>The steps that set the time <span class="hint">in order, biggest first is the one to fix</span></h3>
<ol class="steps">
	{#each steps as s (s.i)}
		{@const g = save_at.get(s.i)}
		<li id="tl-step-{s.i}" class:picked={picked === s.i}>
			<i class="sw" style="background:{dot(s.seg)}"></i>
			<b>{fmt_ms(s.ms)} ms</b>
			<span class="pct">({s.pct.toFixed(0)}%)</span>
			{#if s.seg.kind === 'cpu'}
				<span class="what">CPU: {s.seg.label}</span>
				{#if s.seg.detail}<span class="hint">— mostly {s.seg.detail}</span>{/if}
				{#if s.seg.file}<span class="file">{s.seg.file}</span>{/if}
			{:else if s.seg.kind === 'wait'}
				<span class="what">waiting: {s.seg.label}</span>
				{#if s.seg.calls && s.seg.calls.length > 1}
					<span class="hint">— {s.seg.calls.map((c) => `${c.label} ${fmt_ms(c.ms)} ms`).join(', ')}</span>
				{:else if s.seg.calls?.[0]?.caller}
					<span class="hint">— from {s.seg.calls[0].callers && s.seg.calls[0].callers.length > 1 ? s.seg.calls[0].callers.join(' ← ') : s.seg.calls[0].caller}</span>
				{/if}
				{#if s.seg.calls?.length === 1 && s.seg.calls[0].timings?.length}
					{@const tm = s.seg.calls[0].timings}
					{@const theirs = tm.reduce((a, t) => a + t.ms, 0)}
					<div class="inside">
						their Server-Timing: {tm.map((t) => `${t.desc ?? t.name} ${fmt_ms(t.ms)} ms`).join(' · ')}{#if theirs > 0} — <b>{fmt_ms(theirs)} ms on their side</b>, {fmt_ms(Math.max(0, s.ms - theirs))} ms network + framework{/if}
					</div>
				{/if}
			{:else}
				<span class="what">nothing recorded</span>
				<span class="hint">— a promise chain, a driver on its own socket pool, a worker</span>
			{/if}
			<span class="pchip">{PHASE_LABEL[s.seg.phase]}</span>
			{#if s.seg.within && !s.seg.label.startsWith('in ')}<span class="pchip span">in {s.seg.within}</span>{/if}
			{#if s.seg.inside && s.seg.inside.length > 1}
				<div class="inside">
					{s.seg.parts} pieces: {s.seg.inside.slice(0, 5).map((p) => `${p.label} ${fmt_ms(p.ms)} ms`).join(' · ')}{s.seg.inside.length > 5 ? ' · …' : ''}
				</div>
			{/if}
			{#if g}
				<div class="save">
					{g.calls.length} calls ran one after another ({chain_label(g.calls)}): started together they would cost
					{fmt_ms(g.ms - g.save_ms)} ms instead of {fmt_ms(g.ms)} — <b>save ~{fmt_ms(g.save_ms)} ms</b> if they are independent.
				</div>
			{/if}
		</li>
	{/each}
</ol>
{#each orphan_saves as g (g.at[0])}
	<div class="save orphan">
		Between the steps above, {g.calls.length} small calls ran one after another for {fmt_ms(g.ms)} ms
		({chain_label(g.calls)}): started together they would cost {fmt_ms(g.ms - g.save_ms)} ms —
		<b>save ~{fmt_ms(g.save_ms)} ms</b> if they are independent.
	</div>
{/each}

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 6px 0 4px;
		font-size: 11.5px;
		color: var(--text-dim);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend i {
		width: 12px;
		height: 12px;
		border-radius: 2px;
		display: inline-block;
	}
	.legend i.stripe {
		background: repeating-linear-gradient(135deg, var(--c) 0 3px, var(--bg-sunken) 3px 5px);
	}
	.legend .hint {
		flex-basis: 100%;
		color: var(--text-faint);
	}
	.bar {
		display: flex;
		height: 34px;
		border-radius: 7px;
		overflow: hidden;
		border: 1px solid var(--line);
		margin: 4px 0 0;
		background: var(--bg-sunken);
	}
	.seg {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		font-size: 10.5px;
		font-weight: 600;
		display: flex;
		align-items: center;
		padding: 0 4px;
		border-right: 1px solid var(--bg-sunken)99;
		cursor: pointer;
		color: var(--bg-sunken);
	}
	.seg span {
		text-overflow: ellipsis;
		overflow: hidden;
	}
	.seg.wait span {
		color: var(--text);
		background: var(--bg-sunken)aa;
		padding: 0 4px;
		border-radius: 3px;
	}
	.seg.gap {
		color: var(--text-faint);
		font-weight: 400;
	}
	.seg:hover,
	.seg.picked {
		outline: 2px solid var(--text);
		outline-offset: -2px;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: 10.5px;
		color: var(--text-faint);
		margin: 2px 2px 0;
	}
	.tip {
		position: fixed;
		pointer-events: none;
		background: var(--bg-hover);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 7px 10px;
		font-size: 12px;
		max-width: 480px;
		z-index: 10;
		box-shadow: 0 4px 16px #0008;
		line-height: 1.45;
	}
	.tip-h {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 3px;
	}
	.tip-h i {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dim {
		color: var(--text-faint);
	}
	.totals {
		margin: 8px 0 10px;
	}
	h3 {
		font-size: 13px;
		color: var(--text);
		margin: 14px 0 4px;
		font-weight: 600;
	}
	h3 .hint {
		font-weight: 400;
		color: var(--text-faint);
		margin-left: 6px;
	}
	.lanes {
		display: grid;
		gap: 4px;
	}
	.lane {
		display: grid;
		grid-template-columns: 300px 1fr 260px;
		gap: 10px;
		align-items: center;
		font-size: 12.5px;
	}
	.lane.chained .lbar {
		outline: 1px solid var(--warn);
	}
	.lname code {
		font-size: 12px;
	}
	.kind {
		display: inline-block;
		margin-left: 6px;
		font-size: 10.5px;
		color: var(--text-faint);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 6px;
		line-height: 15px;
	}
	.kind.universal {
		color: var(--c-blue);
		border-color: #2a3a5a;
	}
	.kind.parent {
		color: var(--warn);
		border-color: #5a4a20;
	}
	.ltrack {
		position: relative;
		height: 12px;
		background: var(--bg-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.lbar {
		position: absolute;
		top: 0;
		bottom: 0;
		background: repeating-linear-gradient(135deg, var(--c-blue) 0 4px, var(--bg-sunken) 4px 6px);
		border-radius: 2px;
	}
	.lcpu {
		height: 100%;
		background: #4a9d6e;
	}
	.lane .num {
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
		white-space: nowrap;
	}
	.save.chain {
		margin-top: 6px;
	}
	.phases {
		display: grid;
		gap: 4px;
	}
	.prow {
		display: grid;
		grid-template-columns: 170px 1fr 220px;
		gap: 10px;
		align-items: center;
		font-size: 12.5px;
	}
	.prow .name {
		color: var(--text);
	}
	.track {
		display: flex;
		height: 12px;
		background: var(--bg-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.track .cpu {
		background: #4a9d6e;
	}
	.track .wait {
		background: repeating-linear-gradient(135deg, var(--c-blue) 0 4px, var(--bg-sunken) 4px 6px);
	}
	.prow .num {
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}
	.steps {
		margin: 4px 0 0;
		padding-left: 22px;
		font-size: 13px;
		line-height: 1.6;
	}
	.steps li {
		margin: 2px 0;
		padding: 2px 6px;
		border-radius: 4px;
	}
	.steps li.picked {
		background: var(--bg-raised);
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		vertical-align: -1px;
		margin-right: 3px;
	}
	.steps .what {
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
	}
	.steps .pct,
	.steps .hint,
	.steps .inside {
		color: var(--text-faint);
	}
	.steps .inside {
		font-size: 12px;
		margin-left: 14px;
	}
	.steps .file {
		color: var(--text-faint);
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		margin-left: 6px;
	}
	.pchip {
		display: inline-block;
		margin-left: 8px;
		font-size: 11px;
		color: var(--text-faint);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 0 7px;
		line-height: 16px;
	}
	.pchip.span {
		color: var(--warn);
		border-color: #5a4a20;
	}
	.save.orphan {
		margin-left: 22px;
	}
	.save {
		margin: 4px 0 6px;
		padding: 6px 10px;
		background: var(--bg-raised);
		border-left: 3px solid var(--warn);
		border-radius: 4px;
		font-size: 12.5px;
	}
	/* GC pauses under the bar: a red tick per pause, sized by its length, hover for its cause */
	.gc-row {
		position: relative;
		height: 26px;
		margin-top: 2px;
	}
	.gc-tick {
		position: absolute;
		top: 0;
		height: 8px;
		min-width: 2px;
		background: var(--bad);
		border-radius: 1px;
		cursor: help;
	}
	.gc-tick.major {
		background: #ff4d4d;
		height: 12px;
	}
	.gc-tick.incremental,
	.gc-tick.weak {
		background: var(--warn);
	}
	.gc-label {
		position: absolute;
		left: 0;
		top: 13px;
		font-size: 10px;
	}
</style>
