<script lang="ts">
	/**
	 * THE RENDER, STEPPED — one step at a time through the window (steps.ts): this component
	 * rendered for this long, then the server waited for that, then… with how far into the
	 * render we are, the CPU so far, and the stack at the step's middle. A slider and two keys
	 * (← →) instead of a chart, for the reader who wants to walk it. A `wake:'load'` island.
	 */
	import type { RenderSteps, RenderStep } from '../steps.js';
	import { fmt_ms, CATEGORY_COLOR } from './format.js';

	let { steps }: { steps: RenderSteps } = $props();

	let i = $state(0);
	const n = steps.steps.length;
	const cur = $derived<RenderStep>(steps.steps[Math.min(i, n - 1)]);
	const pct = (ms: number) => (steps.window_ms > 0 ? (ms / steps.window_ms) * 100 : 0);
	const color = (s: RenderStep) => (s.kind === 'wait' ? '#2a3830' : (CATEGORY_COLOR[s.category as keyof typeof CATEGORY_COLOR] ?? '#6b7280'));
	const go = (d: number) => (i = Math.max(0, Math.min(n - 1, i + d)));
	function keys(e: KeyboardEvent) {
		if (e.key === 'ArrowRight') {
			go(1);
			e.preventDefault();
		} else if (e.key === 'ArrowLeft') {
			go(-1);
			e.preventDefault();
		} else if (e.key === 'End') {
			i = n - 1;
			e.preventDefault();
		} else if (e.key === 'Home') {
			i = 0;
			e.preventDefault();
		}
	}
	// the biggest few steps, as jump targets
	const big = [...steps.steps].sort((a, b) => b.ms - a.ms).slice(0, 5);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
<div class="stepper" tabindex="0" onkeydown={keys} role="group" aria-label="the render step by step">
	<div class="track" role="img" aria-label="the render's steps in order">
		{#each steps.steps as s (s.i)}
			<button
				class="seg"
				class:wait={s.kind === 'wait'}
				class:on={s.i === cur.i}
				style="left:{pct(s.t0)}%;width:{Math.max(pct(s.ms), 0.2)}%;background:{color(s)}"
				title="{s.label} · {fmt_ms(s.ms)} ms"
				onclick={() => (i = s.i)}
				aria-label="step {s.i + 1}: {s.label}"
			></button>
		{/each}
	</div>
	<div class="ctl">
		<button onclick={() => go(-1)} disabled={i === 0} aria-label="previous step">←</button>
		<!-- no `bind:` here: the router-CSS leg compiles this template without its script, and a
		     binding to an undeclared name throws there, which ships the whole style block UNSCOPED -->
		<input type="range" min="0" max={n - 1} value={i} oninput={(e) => (i = Number(e.currentTarget.value))} aria-label="step" />
		<button onclick={() => go(1)} disabled={i >= n - 1} aria-label="next step">→</button>
		<span class="hint">step {cur.i + 1} of {n} · {fmt_ms(cur.at_ms)} ms into the render · {fmt_ms(cur.cpu_so_far_ms)} ms CPU so far</span>
	</div>
	<div class="card">
		<div class="head">
			<i class="dot" style="background:{color(cur)}"></i>
			{#if cur.kind === 'wait'}
				<b>waited</b> {fmt_ms(cur.ms)} ms for <b>{cur.label}</b>
			{:else}
				<b>{cur.label}</b> ran for <b>{fmt_ms(cur.ms)} ms</b>
			{/if}
			<span class="hint">{fmt_ms(cur.t0)} → {fmt_ms(cur.t1)} ms{#if cur.folded} · {cur.folded} smaller step{cur.folded === 1 ? '' : 's'} folded in{/if}</span>
		</div>
		{#if cur.file}<div class="hint file">{cur.file}</div>{/if}
		{#if cur.detail && cur.detail !== cur.label}<div class="hint">burning inside it: <b>{cur.detail}</b></div>{/if}
		{#if cur.within}<div class="hint">inside span <b>{cur.within}</b></div>{/if}
		{#if cur.calls?.length}
			<ul class="calls">
				{#each cur.calls.slice(0, 8) as c, k (k)}
					<li>{c.label} <span class="hint">{fmt_ms(c.ms)} ms</span></li>
				{/each}
				{#if cur.calls.length > 8}<li class="hint">+{cur.calls.length - 8} more in flight</li>{/if}
			</ul>
		{/if}
		{#if cur.stack?.length}
			<div class="hint" style="margin-top:6px">the stack at its middle, outermost first:</div>
			<ol class="stack">
				{#each cur.stack as f, k (k)}<li>{f}</li>{/each}
			</ol>
		{/if}
	</div>
	<p class="hint jumps">
		longest steps:
		{#each big as s (s.i)}
			<button class="lnk" onclick={() => (i = s.i)}>{s.kind === 'wait' ? 'wait for ' : ''}{s.label} <b>{fmt_ms(s.ms)}</b></button>
		{/each}
		· {fmt_ms(steps.cpu_ms)} ms on the CPU, {fmt_ms(steps.wait_ms)} ms waiting · ← → keys step
	</p>
</div>

<style>
	.stepper {
		outline: none;
		margin: 6px 0 10px;
	}
	.stepper:focus-visible {
		box-shadow: 0 0 0 2px var(--accent-line);
		border-radius: var(--r-sm);
	}
	.track {
		position: relative;
		height: 22px;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		overflow: hidden;
	}
	.seg {
		position: absolute;
		top: 0;
		height: 100%;
		border: 0;
		padding: 0;
		margin: 0;
		cursor: pointer;
		box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.4);
		opacity: 0.85;
	}
	.seg.wait {
		background-image: repeating-linear-gradient(45deg, transparent 0 3px, rgba(255, 255, 255, 0.08) 3px 6px);
	}
	.seg.on {
		opacity: 1;
		box-shadow: inset 0 0 0 2px var(--accent-strong);
		z-index: 1;
	}
	.ctl {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 8px 0;
		font-size: 12px;
		flex-wrap: wrap;
	}
	.ctl input[type='range'] {
		flex: 1 1 200px;
		min-width: 120px;
	}
	.ctl button {
		padding: 2px 10px;
	}
	.card {
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		padding: 10px 12px;
		background: var(--bg-raised);
		font-size: 13px;
	}
	.head {
		display: flex;
		gap: 6px;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		align-self: center;
	}
	.file {
		font-family: var(--font-mono);
		color: var(--text-faint);
	}
	.calls {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12px;
	}
	.stack {
		margin: 2px 0 0;
		padding-left: 22px;
		font-size: 12px;
		line-height: 1.45;
		font-family: var(--font-mono);
	}
	.jumps .lnk {
		background: none;
		border: 1px solid var(--line-strong);
		color: inherit;
		font: inherit;
		font-size: 12px;
		padding: 0 6px;
		border-radius: var(--r-sm);
		cursor: pointer;
		margin: 0 2px;
	}
	.jumps .lnk:hover {
		border-color: var(--accent-line);
		color: var(--accent-strong);
	}
</style>
