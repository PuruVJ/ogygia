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
	.wf {
		position: relative;
		background: #0c0f13;
		border: 1px solid #232a35;
		border-radius: 8px;
		padding: 8px 0;
		margin: 8px 0;
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
		background: #5b8fd6;
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
			0 0 0 2px #6cb2ff,
			0 0 0 4px #0c0f13;
	}
	.wf-bar.err {
		background: #c1544f;
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
		color: #eaf1fb;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
	}
	.wf-label {
		position: absolute;
		font: 11px ui-monospace, monospace;
		color: #aeb6c2;
		top: 4px;
		white-space: nowrap;
		pointer-events: none;
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
		background: #0e1219;
		border-left: 1px solid #232a35;
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
		color: #aeb6c2;
		font-weight: 600;
	}
	.wf-drawer-head .ru {
		font-family: ui-monospace, monospace;
		color: #7d8590;
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
		color: #7d8590;
		font-size: 15px;
		cursor: pointer;
		padding: 2px 7px;
		border-radius: 5px;
		line-height: 1;
	}
	.wf-close:hover {
		background: #1a1f28;
		color: #d8dee6;
	}
	.wf-drawer-body {
		padding: 12px 14px 20px;
		overflow: auto;
	}
	.wf-drawer-body h4 {
		font-size: 11px;
		color: #7d8590;
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
		color: #7d8590;
	}
	.wf-drawer-body dd {
		color: #d8dee6;
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
		background: #0a0d11;
		border: 1px solid #1c222c;
		border-radius: 6px;
		font: 12px ui-monospace, monospace;
		color: #cdd6e0;
		word-break: break-all;
		white-space: pre-wrap;
	}
</style>
