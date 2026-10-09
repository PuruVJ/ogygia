<script lang="ts">
	// PICK YOUR FIXES: the forecast's parts as a checklist — tick the ones you will make, and the
	// render after them is counted the forecast's way (each saving once, each resource capped by
	// what the render used), right here in the browser. A fix another covers comes with it.
	import { saving_of } from '../saving.js';
	import { fmt_ms } from './format.js';

	type Part = { title: string; kind: string; ms: number; wait: boolean; with?: string[] };
	let { parts, now_ms, caps }: { parts: Part[]; now_ms: number; caps?: { wait?: number; cpu?: number } } = $props();

	// all ticked at first: the forecast's own number
	// svelte-ignore state_referenced_locally
	let on = $state(parts.map(() => true));
	const picked = $derived(parts.filter((_, i) => on[i]));
	const result = $derived(saving_of(picked, caps ?? {}, now_ms));
	const pct = $derived(now_ms > 0 ? Math.round(((now_ms - result.after) / now_ms) * 100) : 0);
</script>

<div class="whatif">
	<p class="sum">
		With the <b>{picked.length}</b> fix{picked.length === 1 ? '' : 'es'} ticked: about <b>{fmt_ms(result.after)} ms</b> a render
		<span class="hint">(from {fmt_ms(now_ms)} ms, −{pct}%)</span>
		{#if result.clamped}<span class="hint">· they claim more than the render used: held at what it used</span>{/if}
	</p>
	<ul>
		{#each parts as p, i (p.title)}
			<li>
				<label>
					<input type="checkbox" bind:checked={on[i]} />
					<span class="t">{p.title}</span>
					<span class="ms">{p.wait ? 'waiting' : p.kind === 'unread-work' ? 'deleted' : 'CPU'} ~{fmt_ms(p.ms)} ms</span>
				</label>
				{#if p.with?.length}<span class="hint covers">also covers {p.with.join('; ')}</span>{/if}
			</li>
		{/each}
	</ul>
	<p class="hint">
		<button type="button" onclick={() => (on = parts.map(() => true))}>Tick all</button>
		<button type="button" onclick={() => (on = parts.map(() => false))}>Clear</button>
	</p>
</div>

<style>
	.whatif {
		margin: 8px 0 12px;
	}
	.sum {
		margin: 0 0 6px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	li {
		font-size: 13px;
	}
	label {
		display: flex;
		gap: 8px;
		align-items: baseline;
		cursor: pointer;
	}
	.t {
		flex: 1;
	}
	.ms {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
		opacity: 0.8;
		white-space: nowrap;
	}
	.covers {
		display: block;
		margin-left: 24px;
		font-size: 12px;
	}
	button {
		font: inherit;
		font-size: 12px;
		margin-right: 6px;
	}
</style>
