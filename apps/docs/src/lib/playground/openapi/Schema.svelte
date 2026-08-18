<script lang="ts">
	/**
	 * Recursive OpenAPI schema renderer. Walks an already-dereferenced schema (see `openapi.ts`):
	 * objects list their properties (name · type · required · description), arrays show their item
	 * type, enums their allowed values, and a `$ref`-derived `name` is shown as the component it came
	 * from. Nested objects are collapsible so a deep schema stays scannable.
	 */
	import type { OASchema } from '../openapi';
	import Self from './Schema.svelte';

	let { schema, open = true, name }: { schema?: OASchema; open?: boolean; name?: string } = $props();

	const s = $derived(schema ?? {});
	const type = $derived((s.type as string) ?? (s.$circular ? 'circular' : s.properties ? 'object' : s.name ? s.name : 'any'));
	const required = $derived(new Set((s.required as string[] | undefined) ?? []));
	const fields = $derived(Object.entries((s.properties as Record<string, OASchema> | undefined) ?? {}));
	const enumVals = $derived(s.enum as unknown[] | undefined);
	const items = $derived(s.items as OASchema | undefined);
	// Toggle override, `null` until the user clicks — so `open` stays the default without capturing it
	// in a state initializer (which would warn and not track).
	let toggled = $state<boolean | null>(null);
	const expanded = $derived(toggled ?? open);
</script>

{#if s.$circular}
	<span class="oa-schema-ref oa-circular" title="circular reference">↻ {s.name}</span>
{:else if type === 'object' && fields.length}
	<div class="oa-object">
		<button class="oa-object-head" onclick={() => (toggled = !expanded)} aria-expanded={expanded}>
			<span class="oa-caret" class:oa-open={expanded}>▸</span>
			<span class="oa-type">{s.name ?? 'object'}</span>
			<span class="oa-count">{fields.length} field{fields.length === 1 ? '' : 's'}</span>
		</button>
		{#if expanded}
			<ul class="oa-props">
				{#each fields as [key, ps] (key)}
					<li class="oa-prop">
						<div class="oa-prop-head">
							<code class="oa-prop-name">{key}</code>
							<span class="oa-prop-type">{ps.name ?? ps.type ?? 'any'}{ps.format ? ` · ${ps.format}` : ''}</span>
							{#if required.has(key)}<span class="oa-required">required</span>{/if}
						</div>
						{#if ps.description}<p class="oa-prop-desc">{ps.description}</p>{/if}
						{#if (ps.type === 'object' && ps.properties) || ps.type === 'array' || ps.enum}
							<div class="oa-nested"><Self schema={ps} open={false} /></div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else if type === 'array'}
	<div class="oa-array">
		<span class="oa-type">array</span> of
		{#if items?.properties || items?.type === 'array'}
			<div class="oa-nested"><Self schema={items} open={false} /></div>
		{:else}
			<span class="oa-type">{items?.name ?? items?.type ?? 'any'}</span>
		{/if}
	</div>
{:else if enumVals}
	<div class="oa-enum">
		<span class="oa-type">{type}</span>
		<span class="oa-enum-vals">{#each enumVals as v, i (i)}<code>{JSON.stringify(v)}</code>{/each}</span>
	</div>
{:else}
	<span class="oa-type">{s.name ?? type}{s.format ? ` · ${s.format}` : ''}</span>
	{#if s.example !== undefined}<span class="oa-example">e.g. <code>{JSON.stringify(s.example)}</code></span>{/if}
{/if}

<style>
	.oa-object {
		border: 1px solid var(--og-border, #e2e2e6);
		border-radius: 8px;
		overflow: hidden;
	}
	.oa-object-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.4rem 0.6rem;
		background: var(--og-surface-2, #f6f6f8);
		border: 0;
		font: inherit;
		cursor: pointer;
		color: var(--og-text, #111);
	}
	.oa-caret {
		display: inline-block;
		transition: transform 0.12s ease;
		color: var(--og-text-dim, #888);
		font-size: 0.7rem;
	}
	.oa-caret.oa-open {
		transform: rotate(90deg);
	}
	.oa-type {
		font-family: var(--og-mono, monospace);
		font-size: 0.82rem;
		color: var(--og-accent, #3b6ea5);
	}
	.oa-count {
		margin-left: auto;
		font-size: 0.75rem;
		color: var(--og-text-dim, #888);
	}
	.oa-props {
		list-style: none;
		margin: 0;
		padding: 0.2rem 0.6rem 0.5rem;
	}
	.oa-prop {
		padding: 0.4rem 0;
		border-top: 1px solid var(--og-border, #eee);
	}
	.oa-prop:first-child {
		border-top: 0;
	}
	.oa-prop-head {
		display: flex;
		align-items: baseline;
		gap: 0.55rem;
		flex-wrap: wrap;
	}
	.oa-prop-name {
		font-family: var(--og-mono, monospace);
		font-weight: 600;
		color: var(--og-text, #111);
	}
	.oa-prop-type {
		font-family: var(--og-mono, monospace);
		font-size: 0.8rem;
		color: var(--og-accent, #3b6ea5);
	}
	.oa-required {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #b4531f;
		background: color-mix(in oklab, #b4531f 12%, transparent);
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
	}
	.oa-prop-desc {
		margin: 0.2rem 0 0;
		font-size: 0.85rem;
		color: var(--og-text-dim, #666);
	}
	.oa-nested {
		margin-top: 0.4rem;
	}
	.oa-array,
	.oa-enum {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.oa-enum-vals {
		display: inline-flex;
		gap: 0.3rem;
		flex-wrap: wrap;
	}
	.oa-enum-vals code,
	.oa-example code {
		font-family: var(--og-mono, monospace);
		font-size: 0.78rem;
		background: var(--og-surface-2, #f2f2f5);
		padding: 0.05rem 0.35rem;
		border-radius: 4px;
	}
	.oa-example {
		margin-left: 0.5rem;
		font-size: 0.8rem;
		color: var(--og-text-dim, #888);
	}
	.oa-circular {
		font-family: var(--og-mono, monospace);
		font-size: 0.8rem;
		color: var(--og-text-dim, #999);
	}
</style>
