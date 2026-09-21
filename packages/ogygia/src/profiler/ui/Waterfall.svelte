<script lang="ts">
	/**
	 * The network waterfall — an island (`wake:'load'`). Each bar shows its response size; clicking a
	 * bar opens a side panel with the full request detail (trigger, sizes, timing, headers, payload).
	 * Replaces the old expand-in-place request list. No `$effect`: the panel is pure `selected` state
	 * toggled by click / Escape (see reactivity-dom-preferences). Styles live in style.ts (the shipped
	 * profiler UI uses one global sheet, not scoped CSS — see style.ts).
	 */
	import { fmt_ms, fmt_bytes } from './format.js';
	import type { WfRow, WfCall } from './report-data.js';

	let { rows }: { rows: WfRow[] } = $props();
	let selected = $state<WfCall | null>(null);
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') selected = null;
	}}
/>

<div class="wf">
	<div class="wf-track">
	{#each rows as r}
		<div class="wf-row">
			<button
				type="button"
				class="wf-bar"
				class:err={r.err}
				class:sel={selected === r.call}
				style="left:{r.left}%;width:{r.width}%"
				title={r.title}
				onclick={() => (selected = r.call)}
			>
				{#if r.bodyPct > 5}<span class="body" style="width:{r.bodyPct}%"></span>{/if}
				{#if r.sizeLabel}<span class="wf-size">{r.sizeLabel}</span>{/if}
			</button>
			<span
				class="wf-label"
				style={r.rightAnchored
					? `right:calc(${(100 - r.left).toFixed(1)}% + 6px)`
					: `left:calc(${(r.left + r.width).toFixed(1)}% + 6px)`}>{r.label}</span
			>
		</div>
	{/each}
	</div>
</div>

{#if selected}
	{@const c = selected}
	<!-- Non-modal side panel — no full-screen dimming backdrop (it caused a compositing repaint glitch,
	     and blocked seeing the waterfall). Close with ✕ or Escape; click another bar to switch. -->
	<div class="wf-drawer" role="dialog" aria-label="Request detail">
		<div class="wf-drawer-head">
				<span class="rm">{c.method}</span>
				<span class="ru" title={c.url}>{c.url}</span>
				<span class="rs" class:warn={c.error}>{c.error ? 'ERR' : c.status || '—'}</span>
				<button type="button" class="wf-close" aria-label="Close" onclick={() => (selected = null)}
					>✕</button
				>
			</div>
			<div class="wf-drawer-body">
				<dl>
					<dt>Size</dt>
					<dd>
						{#if c.bytes != null}<b>{fmt_bytes(c.bytes)}</b> decoded{/if}{#if c.transfer_bytes != null && c.transfer_bytes !== c.bytes}{#if c.bytes != null},
							{/if}{fmt_bytes(c.transfer_bytes)} on the wire{#if c.encoding}
								<span class="dim">({c.encoding})</span>{/if}{/if}{#if c.bytes == null && c.transfer_bytes == null}—{/if}
					</dd>
					<dt>Timing</dt>
					<dd>
						{fmt_ms(c.ms)} to headers{#if c.body_ms} · {fmt_ms(c.body_ms)} reading the body{/if}
					</dd>
					<dt>Response</dt>
					<dd>
						{c.error ? 'error' : c.status || '—'}{#if c.type} · {c.type}{/if}{#if c.error} · {c.error}{/if}
					</dd>
					{#if c.route ?? c.path}<dt>Triggered by</dt>
						<dd class="brk">{c.route ?? c.path}</dd>{/if}
					{#if c.caller}<dt>Caller</dt>
						<dd class="brk">{c.caller}</dd>{/if}
					{#if c.callers && c.callers.length > 1}<dt>Call path</dt>
						<dd class="brk">{#each c.callers as k, i (i)}{#if i > 0}<span class="dim"> ← </span>{/if}{k}{/each}</dd>{/if}
					{#if c.timings?.length}
						{@const theirs = c.timings.reduce((a, t) => a + t.ms, 0)}
						<dt>Their side</dt>
						<dd>
							{#each c.timings as t (t.name)}<span class="st"><b>{t.desc ?? t.name}</b> {fmt_ms(t.ms)} ms</span>{/each}
							{#if theirs > 0}<span class="dim">— {fmt_ms(theirs)} ms measured on their side, {fmt_ms(Math.max(0, c.ms - theirs))} ms network + framework (from their Server-Timing)</span>{/if}
						</dd>
					{/if}
					{#if c.trace}
						{@const t = c.trace}
						{@const rest = Math.max(0, t.ms - t.cpu_ms - t.wait_ms)}
						<dt>Inside the upstream</dt>
						<dd>
							<span class="st"><b>{fmt_ms(t.ms)} ms</b> on their profiler's clock{#if t.route} · route <code>{t.route}</code>{/if}</span>
							<span class="trace-bar" title="{fmt_ms(t.cpu_ms)} ms CPU · {fmt_ms(t.wait_ms)} ms waiting on {t.calls} call{t.calls === 1 ? '' : 's'} · {fmt_ms(rest)} ms other">
								<i class="tb-cpu" style="width:{(t.cpu_ms / Math.max(t.ms, 0.01)) * 100}%"></i><i class="tb-wait" style="width:{(t.wait_ms / Math.max(t.ms, 0.01)) * 100}%"></i><i class="tb-rest" style="width:{(rest / Math.max(t.ms, 0.01)) * 100}%"></i>
							</span>
							<span class="dim">{fmt_ms(t.cpu_ms)} ms CPU · {fmt_ms(t.wait_ms)} ms waiting on {t.calls} call{t.calls === 1 ? '' : 's'} · {fmt_ms(rest)} ms other · {fmt_ms(Math.max(0, c.ms - t.ms))} ms network between us</span>
							{#if t.top?.length}
								<span class="dim">their own calls: {#each t.top as u, i (i)}{#if i > 0}, {/if}{u.url.replace(/^https?:\/\/[^/]+/, '')} {fmt_ms(u.ms)} ms{/each}</span>
							{/if}
							{#if t.profiler}<span class="dim">their profiler: <code>{t.profiler}</code></span>{/if}
						</dd>
					{/if}
				</dl>

				<h4>URL</h4>
				<pre class="wf-url">{c.url}</pre>

				{#if c.headers && Object.keys(c.headers).length}
					<h4>Response headers</h4>
					<dl class="hdrs">
						{#each Object.entries(c.headers) as [k, v]}
							<dt>{k}</dt>
							<dd class="brk">{v}</dd>
						{/each}
					</dl>
				{/if}
			</div>
		</div>
{/if}

<style>
	/* The shell scrolls; the track keeps a usable minimum width so a narrow viewport (or the open
	   drawer) pans the timeline instead of crushing the % -positioned bars into unreadability. */
	.wf {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 8px;
		margin: 8px 0;
		overflow-x: auto;
	}
	.wf-track {
		position: relative;
		min-width: 640px;
		padding: 8px 0;
	}
	.wf-row {
		position: relative;
		height: 22px;
	}
	.wf-bar {
		position: absolute;
		height: 16px;
		top: 3px;
		border: 0;
		padding: 0;
		border-radius: 3px;
		background: var(--c-blue);
		min-width: 2px;
		cursor: pointer;
		overflow: hidden;
		display: block;
		transition: filter 0.1s;
	}
	.wf-bar:hover {
		filter: brightness(1.18);
	}
	.wf-bar.sel {
		box-shadow:
			0 0 0 2px var(--c-blue),
			0 0 0 4px var(--bg-sunken);
	}
	.wf-bar.err {
		background: var(--bad);
	}
	.wf-bar .body {
		position: absolute;
		right: 0;
		top: 0;
		height: 100%;
		background: #3a5d8f;
	}
	.wf-size {
		position: absolute;
		left: 5px;
		top: 0;
		height: 100%;
		display: flex;
		align-items: center;
		font: 10px ui-monospace, monospace;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
	}
	.wf-label {
		position: absolute;
		font: 11px ui-monospace, monospace;
		color: var(--text-dim);
		top: 4px;
		white-space: nowrap;
		pointer-events: none;
	}
	.st {
		display: inline-block;
		margin-right: 10px;
	}
	.dim {
		color: #5c636e;
	}
	/* Request side panel — slides in when a waterfall bar is clicked. */
	.wf-drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 40;
		width: min(460px, 92vw);
		background: var(--bg-sunken);
		border-left: 1px solid var(--line);
		box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4);
		display: flex;
		flex-direction: column;
	}
	.wf-drawer-head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-bottom: 1px solid #1c222c;
	}
	.wf-drawer-head .rm {
		font-family: ui-monospace, monospace;
		color: var(--text-dim);
		font-weight: 600;
	}
	.wf-drawer-head .ru {
		font-family: ui-monospace, monospace;
		color: var(--text-faint);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
	.wf-drawer-head .rs {
		color: #8b93a0;
		font-variant-numeric: tabular-nums;
		font-size: 12.5px;
	}
	.wf-close {
		margin-left: auto;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		font-size: 15px;
		cursor: pointer;
		padding: 2px 7px;
		border-radius: 5px;
		line-height: 1;
	}
	.wf-close:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.wf-drawer-body {
		padding: 12px 14px 20px;
		overflow: auto;
	}
	.wf-drawer-body h4 {
		font-size: 11px;
		color: var(--text-faint);
		margin: 16px 0 5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.wf-drawer-body dl {
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr);
		gap: 4px 12px;
		margin: 0;
		font-size: 12.5px;
	}
	.wf-drawer-body dl.hdrs {
		grid-template-columns: minmax(0, 42%) minmax(0, 1fr);
		font-family: ui-monospace, monospace;
		font-size: 12px;
		gap: 3px 12px;
	}
	.wf-drawer-body dt {
		color: var(--text-faint);
	}
	.wf-drawer-body dd {
		color: var(--text);
		margin: 0;
		min-width: 0;
	}
	.wf-drawer-body dd.brk {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		word-break: break-all;
	}
	.wf-url {
		margin: 4px 0 0;
		padding: 8px 10px;
		background: var(--bg-sunken);
		border: 1px solid #1c222c;
		border-radius: 6px;
		font: 12px ui-monospace, monospace;
		color: var(--text-dim);
		word-break: break-all;
		white-space: pre-wrap;
	}
	/* the nested trace: the upstream's own request as a three-part bar */
	.trace-bar {
		display: flex;
		height: 10px;
		width: 100%;
		max-width: 420px;
		background: var(--bg-sunken);
		border-radius: 3px;
		overflow: hidden;
		margin: 4px 0;
	}
	.trace-bar i {
		display: block;
		height: 100%;
	}
	.tb-cpu {
		background: var(--c-orange);
	}
	.tb-wait {
		background: var(--c-blue);
	}
	.tb-rest {
		background: #374151;
	}
</style>
