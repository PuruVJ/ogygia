<script>
	/**
	 * A compact, collapsible tree for a decoded props value — the actual data that crossed the island
	 * boundary. Recursive (imports itself). Objects / arrays / Map / Set expand; leaves are type-
	 * coloured; a transportable that crossed as a hub ref (`__ogRef`) renders as a chip naming the live
	 * object it reunites with (e.g. a wired `Cart`), tying the wire back to the Hub tab.
	 */
	import Self from './PropsTree.svelte';

	let { value, name = null, depth = 0 } = $props();

	function classify(v) {
		if (v === null) return 'null';
		if (v === undefined) return 'undefined';
		if (typeof v === 'object' && v.__ogRef) return 'ref';
		if (v instanceof Date) return 'date';
		if (v instanceof Map) return 'map';
		if (v instanceof Set) return 'set';
		if (Array.isArray(v)) return 'array';
		if (typeof v === 'object') return 'object';
		return typeof v; // string | number | boolean | bigint
	}
	const type = $derived(classify(value));
	const expandable = $derived(['array', 'object', 'map', 'set'].includes(type));

	let open = $state(depth < 2); // auto-expand the top couple of levels

	const entries = $derived.by(() => {
		if (type === 'array') return value.map((v, i) => [i, v]);
		if (type === 'object') return Object.entries(value);
		if (type === 'map') return [...value.entries()].map(([k, v], i) => [`${String(k)}`, v]);
		if (type === 'set') return [...value].map((v, i) => [i, v]);
		return [];
	});
	const preview = $derived.by(() => {
		if (type === 'array') return `Array(${value.length})`;
		if (type === 'object') return `{ ${Object.keys(value).length} }`;
		if (type === 'map') return `Map(${value.size})`;
		if (type === 'set') return `Set(${value.size})`;
		return '';
	});
</script>

<div class="node" style:padding-left="{depth ? 11 : 0}px">
	{#if expandable}
		<button class="row exp" onclick={() => (open = !open)}>
			<span class="tw">{open ? '▾' : '▸'}</span>
			{#if name != null}<span class="key">{name}</span><span class="c">:</span>{/if}
			<span class="prev">{preview}</span>
		</button>
		{#if open}
			{#each entries as [k, v]}
				<Self value={v} name={k} depth={depth + 1} />
			{/each}
		{/if}
	{:else}
		<div class="row leaf">
			{#if name != null}<span class="key">{name}</span><span class="c">:</span>{/if}
			{#if type === 'ref'}
				<span class="ref" title={value.tag || value.id}>
					<span class="rk">{value.kind}</span>{value.tag ? value.tag.split('#').pop() : value.id}
				</span>
			{:else if type === 'string'}
				<span class="str">"{value.length > 90 ? value.slice(0, 90) + '…' : value}"</span>
			{:else if type === 'number'}
				<span class="num">{value}</span>
			{:else if type === 'bigint'}
				<span class="num">{value}n</span>
			{:else if type === 'boolean'}
				<span class="bool">{value}</span>
			{:else if type === 'date'}
				<span class="date">{value.toISOString()}</span>
			{:else}
				<span class="nul">{type}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.node {
		line-height: 1.6;
	}
	.row {
		display: block;
		text-align: left;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font: inherit;
		white-space: nowrap;
	}
	.exp {
		cursor: pointer;
	}
	.tw {
		display: inline-block;
		width: 12px;
		color: #64748b;
	}
	.leaf {
		padding-left: 12px;
	}
	.key {
		color: #7dd3fc;
	}
	.c {
		color: #64748b;
		margin: 0 5px 0 1px;
	}
	.prev {
		color: #64748b;
	}
	.str {
		color: #6ee7b7;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.num {
		color: #fbbf24;
	}
	.bool {
		color: #c4b5fd;
	}
	.date {
		color: #f0abfc;
	}
	.nul {
		color: #64748b;
	}
	.ref {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 0 7px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.16);
		color: #5eead4;
		font-weight: 600;
	}
	.ref .rk {
		color: #0f766e;
		background: #5eead4;
		border-radius: 999px;
		padding: 0 5px;
		font-size: 9px;
		text-transform: uppercase;
	}
</style>
