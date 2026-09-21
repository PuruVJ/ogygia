<script lang="ts">
	/**
	 * KEPT IN THIS BROWSER — the reports this browser holds in its own store (ui/store.ts), listed
	 * on the dashboard next to the server's. On an ephemeral host this is THE list: the server's is
	 * empty a minute later. Each opens at its `/report/<id>` (the page falls back to the store when
	 * the server has forgotten it); two of the same page compare.
	 */
	import { list_reports, delete_report, type StoredDump } from './store.js';
	import { fmt_ms } from './format.js';

	let { base, server_ids = [] }: { base: string; server_ids?: string[] } = $props();
	let rows = $state<Omit<StoredDump, 'dump'>[]>([]);
	let loaded = $state(false);
	const on_server = new Set(server_ids);
	void list_reports()
		.then((r) => (rows = r))
		.finally(() => (loaded = true));
	const when = (ms: number) => new Date(ms).toLocaleString();
	/** the previous kept report of the same page, for a compare link */
	const prev_of = (r: Omit<StoredDump, 'dump'>) => rows.find((o) => o.page === r.page && o.at < r.at && o.trigger === 'page');
	async function forget(id: string) {
		await delete_report(id);
		rows = rows.filter((r) => r.id !== id);
	}
</script>

{#if loaded && rows.length}
	<h2>Kept in this browser <span class="hint" style="font-weight:400">({rows.length} — reports this browser stored itself; they outlive the server)</span></h2>
	<table>
		<thead><tr><th>when</th><th>page</th><th class="num">median</th><th>on this server</th><th></th></tr></thead>
		<tbody>
			{#each rows as r (r.id)}
				{@const prev = prev_of(r)}
				<tr>
					<td class="file">{when(r.at)}</td>
					<td class="fn"><a href="{base}/report/{r.id}">{r.label}</a> <span class="hint">{r.trigger}</span></td>
					<td class="num">{r.median !== null ? `${fmt_ms(r.median)} ms` : '—'}</td>
					<td class="file">{on_server.has(r.id) ? 'yes' : 'no (browser only)'}</td>
					<td class="file">
						{#if prev}<a href="{base}/compare/{prev.id}/{r.id}">compare with previous</a> · {/if}
						<button class="link" onclick={() => forget(r.id)}>forget</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.link {
		background: none;
		border: 0;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
		padding: 0;
	}
</style>
