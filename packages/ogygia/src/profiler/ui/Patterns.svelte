<script lang="ts">
	/**
	 * SLOW PATTERNS: the known slow shapes found on the costly lines (patterns.ts), one card each,
	 * biggest estimated win first. Each says what is happening, the numbers behind it, every place
	 * it happens (with the code), and what to do. Static markup; the example sits in a <details>.
	 */
	import type { Pattern } from '../patterns.js';
	import { fmt_ms, fmt_bytes } from './format.js';
	import { row_href } from './row-anchor.svelte.js';

	// `renders`: how many renders the CPU numbers add up (page mode); a wait pattern is one render's
	let { patterns, busy_ms = 0, renders = 1, fns }: { patterns: Pattern[]; busy_ms?: number; renders?: number; fns?: string[] } = $props();
	// a site links to its function's row only when the functions table has that row
	const known = $derived(fns ? new Set(fns) : null);
	const linkable = (fn: string | undefined): fn is string => !!fn && (!known || known.has(fn));
	const per = (ms: number) => ms / Math.max(1, renders);

	const share = (ms: number) => (busy_ms > 0 ? Math.round((ms / busy_ms) * 100) : 0);

	/** the context lines with their common indent removed (tabs shown as two spaces) */
	function dedent(lines: string[]): string[] {
		const t = lines.map((l) => l.replaceAll('\t', '  '));
		let cut = Infinity;
		for (const l of t) {
			if (!l.trim()) continue;
			cut = Math.min(cut, l.length - l.trimStart().length);
		}
		return Number.isFinite(cut) ? t.map((l) => l.slice(cut)) : t;
	}
</script>

<div class="pats">
	<!-- keyed by kind + title: two library patterns share a kind, and a duplicate key kills the island -->
	{#each patterns as p, i (p.kind + '\0' + p.title)}
		<!-- `pattern-<index>`: a finding that names the same problem links here -->
		<article class="pat" id="pattern-{i}">
			<header>
				<h3>{p.title}</h3>
				{#if p.save_ms >= 0.1}
					<span class="save" title="A rough estimate from what these lines cost">
						{#if p.kind === 'same-document' || p.kind === 'almost-same-document'}saves ~{fmt_ms(p.save_ms)} ms: the whole render, answered from a cache{:else if p.wait}saves ~{fmt_ms(p.save_ms)} ms of waiting{:else}saves ~{fmt_ms(per(p.save_ms))} ms{renders > 1 ? ' per render' : ''}{#if share(p.save_ms) >= 1}&nbsp;({share(p.save_ms)}% of CPU){/if}{/if}
					</span>
				{:else if p.seed_bytes}
					<span class="save" title="The page seed, sent to the browser with every page view">ships {fmt_bytes(p.seed_bytes)} per page view</span>
				{:else if p.kept_bytes}
					<span class="save" title="Measured: allocated by one more warm render and still alive after a full collection">
						keeps {fmt_bytes(p.kept_bytes)} per render{#if p.growth === 'grows'} · confirmed{:else if p.growth === 'levels-off'} · levels off{/if}{#if p.requests_left !== undefined} · heap full in ~{p.requests_left.toLocaleString('en-US')} requests{/if}
					</span>
				{/if}
			</header>
			{#if p.evidence}<p class="ev">{p.evidence}</p>{/if}
			<ul class="sites">
				<!-- one line can be several sites: a helper line that calls a different endpoint each time -->
				{#each p.sites as s, i (s.path + ':' + s.line + '\0' + (s.target ?? '') + '\0' + i)}
					<li>
						{#if linkable(s.fn)}
							<a class="loc" href={row_href('fn:' + s.fn)} title={s.path + ':' + s.line}>{s.file}:{s.line}</a>
						{:else}
							<span class="loc" title={s.path + ':' + s.line}>{s.file}:{s.line}</span>
						{/if}
						{#if s.module}<span class="mod" title="the build has no sourcemap: the line number is the built chunk's">in {s.module}</span>{/if}
						<span class="nums">
							{#if s.wait_ms}{s.calls} call{s.calls === 1 ? '' : 's'} to {s.target} · {fmt_ms(s.wait_ms)} ms waiting{#if s.in_loop} · in a loop{/if}{/if}
						{#if s.answer_bytes !== undefined} · the same {fmt_bytes(s.answer_bytes)} every render{/if}
						{#if s.personal}<span class="tag" title="The request carried a cookie or an authorization header, and the recording rendered as one user: cache it per user, keyed by the session">per user</span>{/if}
						<!-- what the service itself says about keeping its answer (its Cache-Control) -->
						{#if s.upstream_cache?.no_store}<span class="tag" title="The service answered with Cache-Control: no-store — the answer was the same here, but it asks not to be kept. Check with its owner before caching it">service says: don't store</span>
						{:else if s.upstream_cache?.no_cache}<span class="tag" title="The service answered with no-cache (or max-age=0): a copy may be kept, but every reuse must be checked with it first (an ETag or Last-Modified request)">service says: revalidate each time</span>
						{:else if s.upstream_cache?.private && !s.upstream_cache.max_age}<span class="tag" title="The service marks its answer private: one user's, never a shared cache's">service says: private</span>
						{:else if s.upstream_cache?.max_age}<span class="tag" title="The service's own Cache-Control allows keeping a copy this long: caching it that long is within what it promises">service allows {s.upstream_cache.max_age >= 60 ? `${Math.round(s.upstream_cache.max_age / 60)} min` : `${s.upstream_cache.max_age} s`} cache</span>{/if}
							{#if s.hits !== undefined && s.calls}the cache answered {s.hits} of {s.calls} calls{/if}
							{#if s.kept_bytes}{fmt_bytes(s.kept_bytes)} kept{#if s.mem_via}, inside {s.mem_via}{/if}{#if s.grows === true}<span title="Held about one render's worth more after every render of the check. A cache that keeps more entries than the check had renders looks the same."> · grew every render checked</span>{:else if s.grows === false} · stopped growing (a bounded cache){/if}{/if}
							{#if s.cpu_ms > 0}{fmt_ms(per(s.cpu_ms))} ms{/if}
							{#if s.lib_ms}{s.cpu_ms > 0 ? ' · ' : ''}{fmt_ms(per(s.lib_ms))} ms in {s.libs?.[0] ?? 'a library'}{/if}
							{#if s.alloc_bytes > 0}{s.cpu_ms > 0 ? ' · ' : ''}{fmt_bytes(per(s.alloc_bytes))}{/if}
							{#if !s.wait_ms && renders > 1 && (s.cpu_ms > 0 || s.lib_ms || s.alloc_bytes > 0)}&nbsp;per render{/if}
							{#if s.calls && !s.wait_ms && s.hits === undefined}&nbsp;· ×{s.calls}{/if}
						</span>
						{#if s.context}
							{@const shown = dedent(s.context.lines)}
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<pre class="ctx" tabindex="0" aria-label="source around line {s.line}">{#each shown as ln, i (i)}<span class="cl" class:hot={s.context.start + i === s.line}><span class="cn">{s.context.start + i}</span>{ln}
</span>{/each}</pre>
						{:else}
							<code>{s.code}</code>
						{/if}
						{#if s.rewrite}
							<!-- the change, written out: these lines, and what goes in their place -->
							<div class="rewrite">
								<span class="rw-h">The change, at {s.rewrite.file}:{s.rewrite.line}</span>
								<pre class="rw-before">{s.rewrite.before}</pre>
								<pre class="rw-after">{s.rewrite.after}</pre>
							</div>
						{/if}
						{#if s.via?.length}
							<div class="via">
								<span class="vk">called from</span>
								{#each s.via as v (v.path + ':' + v.line)}
									<div class="vrow">
										{#if linkable(v.fn)}<a class="loc" href={row_href('fn:' + v.fn)}>{v.file}:{v.line}</a>{:else}<span class="loc">{v.file}:{v.line}</span>{/if}
										{#if v.in_loop}<span class="inloop">in a loop</span>{/if}
										<code>{v.code}</code>
									</div>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="fix">{p.fix}</p>
			{#if p.example}
				<details>
					<summary>Show an example</summary>
					<div class="ex">
						<span class="exk">before</span>
						<pre>{p.example.before}</pre>
						<span class="exk">after</span>
						<pre>{p.example.after}</pre>
					</div>
				</details>
			{/if}
		</article>
	{/each}
</div>

<style>
	.pats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
		gap: 12px;
	}
	.pat {
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-sunken);
		padding: 12px 14px;
		min-width: 0;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 4px 12px;
	}
	h3 {
		margin: 0;
		font-size: 14px;
		line-height: 1.35;
	}
	.save {
		font-size: 12px;
		font-weight: 600;
		color: var(--c-orange);
		white-space: nowrap;
	}
	.ev {
		margin: 4px 0 8px;
		font-size: 12.5px;
		color: var(--text-dim);
	}
	.sites {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.sites li {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		align-items: baseline;
		font-size: 12px;
		min-width: 0;
	}
	.mod {
		font-size: 12px;
		opacity: 0.75;
		margin-left: 6px;
	}
	.loc {
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: var(--text);
		text-decoration: none;
		word-break: break-all;
	}
	a.loc:hover {
		text-decoration: underline;
	}
	.nums {
		color: var(--text-faint);
	}
	.sites code {
		flex-basis: 100%;
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		color: var(--text-dim);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ctx {
		flex-basis: 100%;
		margin: 4px 0 0;
		padding: 4px 0;
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: 5px;
		font-size: 11.5px;
		line-height: 1.5;
		overflow-x: auto;
		min-width: 0;
	}
	.cl {
		display: block;
		padding: 0 8px;
		white-space: pre;
		color: var(--text-faint);
	}
	.cl.hot {
		color: var(--text);
		background: color-mix(in srgb, var(--c-orange) 16%, transparent);
	}
	.cn {
		display: inline-block;
		width: 3.2em;
		color: var(--text-faint);
		user-select: none;
	}
	.rewrite {
		margin: 6px 0;
	}
	.rw-h {
		font-size: 11px;
		text-transform: uppercase;
		color: var(--text-dim);
	}
	.rewrite pre {
		margin: 3px 0;
		padding: 6px 8px;
		border-radius: 6px;
		font-size: 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.rw-before {
		background: color-mix(in srgb, #dc2626 10%, transparent);
	}
	.rw-after {
		background: color-mix(in srgb, #16a34a 12%, transparent);
	}
	.via {
		flex-basis: 100%;
		margin: 2px 0 0 10px;
		padding-left: 8px;
		border-left: 2px solid var(--line);
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.vk {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.vrow {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 8px;
		align-items: baseline;
		min-width: 0;
	}
	.inloop {
		font-size: 11px;
		color: var(--c-orange);
	}
	.fix {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
	}
	details {
		margin-top: 8px;
	}
	summary {
		cursor: pointer;
		font-size: 12px;
		color: var(--text-dim);
	}
	.ex {
		margin-top: 6px;
		display: grid;
		gap: 4px;
	}
	.exk {
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}
	.ex pre {
		margin: 0;
		padding: 6px 8px;
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: 5px;
		font-size: 11.5px;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
