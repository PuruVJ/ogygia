<script lang="ts">
	/**
	 * Renders one OpenAPI operation from an ogygia `PageView` whose `entry.data` is an `Operation` (see
	 * openapi.ts). It's the `[...slug]` route's alternative to `<Doc>` for the `/api` reference:
	 * method + path header, description, a parameters table grouped by location, the request body and
	 * every response rendered with the recursive `<Schema>`, and the security requirements.
	 *
	 * Note: the spec's descriptions are DATA, not build-authored content, so they render as text — the
	 * `code()` / `md()` macros are for literal authored content, not runtime spec strings.
	 */
	import type { Operation, OAParam } from '../openapi';
	import Schema from './Schema.svelte';

	let { op }: { op: Operation } = $props();

	const byLocation = $derived.by(() => {
		const groups: Record<string, OAParam[]> = {};
		for (const p of op.parameters) (groups[p.in] ??= []).push(p);
		return Object.entries(groups);
	});

	function statusKind(status: string): 'ok' | 'warn' | 'err' | 'info' {
		if (status === 'default') return 'info';
		const n = Number(status);
		if (n < 300) return 'ok';
		if (n < 400) return 'info';
		if (n < 500) return 'warn';
		return 'err';
	}
</script>

<article class="oa-op">
	<header class="oa-op-head">
		<div class="oa-op-line">
			<span class="oa-method oa-m-{op.method}">{op.method.toUpperCase()}</span>
			<code class="oa-path">{op.path}</code>
		</div>
		<h1 class="oa-op-title">{op.summary}</h1>
		{#if op.description}<p class="oa-op-desc">{op.description}</p>{/if}
	</header>

	{#if op.security.length}
		<section class="oa-sec">
			<h2 class="oa-h2">Security</h2>
			<ul class="oa-sec-list">
				{#each op.security as s (s.scheme)}
					<li>
						<code class="oa-scheme">{s.scheme}</code>
						{#if s.scopes.length}<span class="oa-scopes">{s.scopes.join(', ')}</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if op.parameters.length}
		<section>
			<h2 class="oa-h2">Parameters</h2>
			{#each byLocation as [location, params] (location)}
				<h3 class="oa-h3">{location}</h3>
				<table class="oa-params">
					<thead><tr><th>Name</th><th>Type</th><th></th><th>Description</th></tr></thead>
					<tbody>
						{#each params as p (p.name)}
							<tr>
								<td><code class="oa-pname">{p.name}</code></td>
								<td><span class="oa-ptype">{p.schema?.type ?? 'string'}{p.schema?.format ? ` · ${p.schema.format}` : ''}</span></td>
								<td>{#if p.required}<span class="oa-required">required</span>{/if}</td>
								<td>
									{p.description ?? ''}
									{#if p.schema?.enum}<span class="oa-inline-enum">{(p.schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' · ')}</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/each}
		</section>
	{/if}

	{#if op.requestBody}
		<section>
			<h2 class="oa-h2">Request body{#if op.requestBody.required}<span class="oa-required">required</span>{/if}</h2>
			{#if op.requestBody.description}<p class="oa-op-desc">{op.requestBody.description}</p>{/if}
			<p class="oa-media">{op.requestBody.mediaType}</p>
			<Schema schema={op.requestBody.schema} />
		</section>
	{/if}

	<section>
		<h2 class="oa-h2">Responses</h2>
		<ul class="oa-responses">
			{#each op.responses as r (r.status)}
				<li class="oa-response">
					<div class="oa-response-head">
						<span class="oa-status oa-status-{statusKind(r.status)}">{r.status}</span>
						<span class="oa-response-desc">{r.description ?? ''}</span>
						{#if r.mediaType}<span class="oa-media">{r.mediaType}</span>{/if}
					</div>
					{#if r.schema}<div class="oa-response-body"><Schema schema={r.schema} open={false} /></div>{/if}
				</li>
			{/each}
		</ul>
	</section>
</article>

<style>
	.oa-op {
		max-width: 52rem;
	}
	.oa-op-line {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.oa-method {
		font-family: var(--og-mono, monospace);
		font-weight: 700;
		font-size: 0.72rem;
		letter-spacing: 0.03em;
		padding: 0.2rem 0.5rem;
		border-radius: 6px;
		color: #fff;
	}
	.oa-m-get { background: #3b6ea5; }
	.oa-m-post { background: #2f8a52; }
	.oa-m-put { background: #b07b1e; }
	.oa-m-patch { background: #8a6d2f; }
	.oa-m-delete { background: #b4402f; }
	.oa-path {
		font-family: var(--og-mono, monospace);
		font-size: 0.95rem;
		color: var(--og-text, #111);
	}
	.oa-op-title {
		margin: 0.7rem 0 0.3rem;
		font-size: 1.7rem;
	}
	.oa-op-desc {
		color: var(--og-text-dim, #555);
		line-height: 1.6;
		margin: 0.3rem 0 0;
	}
	.oa-h2 {
		font-size: 1.05rem;
		margin: 1.8rem 0 0.7rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.oa-h3 {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--og-text-dim, #888);
		margin: 1rem 0 0.4rem;
	}
	.oa-params {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	.oa-params th {
		text-align: left;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--og-text-dim, #999);
		padding: 0.3rem 0.6rem;
		border-bottom: 1px solid var(--og-border, #e2e2e6);
	}
	.oa-params td {
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--og-border, #f0f0f2);
		vertical-align: top;
	}
	.oa-pname { font-family: var(--og-mono, monospace); font-weight: 600; }
	.oa-ptype { font-family: var(--og-mono, monospace); font-size: 0.82rem; color: var(--og-accent, #3b6ea5); }
	.oa-inline-enum { display: block; margin-top: 0.2rem; font-family: var(--og-mono, monospace); font-size: 0.76rem; color: var(--og-text-dim, #888); }
	.oa-required {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #b4531f;
		background: color-mix(in oklab, #b4531f 12%, transparent);
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
	}
	.oa-media {
		font-family: var(--og-mono, monospace);
		font-size: 0.78rem;
		color: var(--og-text-dim, #888);
		margin: 0.2rem 0 0.5rem;
	}
	.oa-responses { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
	.oa-response-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
	.oa-status {
		font-family: var(--og-mono, monospace);
		font-weight: 700;
		font-size: 0.8rem;
		padding: 0.15rem 0.5rem;
		border-radius: 6px;
	}
	.oa-status-ok { color: #2f8a52; background: color-mix(in oklab, #2f8a52 14%, transparent); }
	.oa-status-info { color: #3b6ea5; background: color-mix(in oklab, #3b6ea5 14%, transparent); }
	.oa-status-warn { color: #b07b1e; background: color-mix(in oklab, #b07b1e 16%, transparent); }
	.oa-status-err { color: #b4402f; background: color-mix(in oklab, #b4402f 14%, transparent); }
	.oa-response-desc { color: var(--og-text, #333); font-size: 0.9rem; }
	.oa-response-body { margin-top: 0.5rem; }
	.oa-sec-list { list-style: none; margin: 0; padding: 0; display: flex; gap: 0.6rem; flex-wrap: wrap; }
	.oa-sec-list li { display: flex; align-items: center; gap: 0.4rem; }
	.oa-scheme {
		font-family: var(--og-mono, monospace);
		font-size: 0.82rem;
		background: var(--og-surface-2, #f2f2f5);
		padding: 0.1rem 0.4rem;
		border-radius: 5px;
	}
	.oa-scopes { font-size: 0.8rem; color: var(--og-text-dim, #888); }
</style>
