<script lang="ts">
	/**
	 * One whole doc page — a pure function of a `DocView`: crumbs, section eyebrow, title, the body
	 * region (islands inside hydrate normally), suggested reading, pager, and the on-page toc. Every
	 * piece removable by prop; the day-1 page is literally `<Doc view={await site.doc(slug)} />`.
	 */
	import Region from '../../Region.svelte';
	import Pager from './Pager.svelte';
	// An island (`wake: 'load'`) so its scrollspy hydrates per page and RE-hydrates after every SPA
	// navigation — the fix for "no active outline until reload". Only `headings` (plain data) crosses.
	import OnThisPage from './OnThisPage.svelte' with { wake: 'load' };
	// Island so the copy buttons re-attach after every SPA navigation (the observer version died with
	// the old `.ph-body`). No props cross the boundary.
	import CodeChrome from './CodeChrome.svelte' with { wake: 'load' };
	import { get_shell_context } from '../context.js';
	import type { DocView, NavRef } from '../types.js';

	let {
		view,
		// Off by default: the section eyebrow ("GUIDES") already names the category, so a "Guides / Intro"
		// trail on top of it just repeats it. Opt in with `crumbs` for deep trees that need the path.
		crumbs = false,
		toc = true,
		pager = true,
		suggested = true,
		keepReading
	}: {
		view: DocView;
		crumbs?: boolean;
		toc?: boolean;
		pager?: boolean;
		suggested?: boolean;
		/** Refs for the "keep reading" cards. Defaults to the trail's policy-selected `suggested`;
		 *  pass `view.trail.related` to show curated links only (when a pager already covers order). */
		keepReading?: NavRef[];
	} = $props();

	// The user's schema owns `data`; the default chrome reads the two conventional display fields.
	const data = $derived(view.entry.data as { title?: string; summary?: string });
	const title = $derived(data.title ?? view.slug);
	const reading = $derived(keepReading ?? view.trail.suggested);

	// Per-page document metadata. `<title>` is "Page — Site" when the shell names a site, else just the
	// page. Removable by not rendering <Doc>, but every doc should carry a title, so it's on by default.
	const shell = get_shell_context();
	const doc_title = $derived(shell?.title ? `${title} — ${shell.title}` : title);
</script>

<svelte:head>
	<title>{doc_title}</title>
	{#if data.summary}<meta name="description" content={data.summary} />{/if}
</svelte:head>

<div class="ph-doc">
	<article class="ph-article">
		{#if crumbs && view.crumbs.length > 1}
			<nav class="ph-crumbs" aria-label="Breadcrumb">
				{#each view.crumbs as c (c.label)}<span class="ph-crumb">{c.label}</span>{/each}
			</nav>
		{/if}
		{#if view.section}<p class="ph-eyebrow">{view.section}</p>{/if}
		<h1 class="ph-title">{title}</h1>
		{#if data.summary}<p class="ph-summary">{data.summary}</p>{/if}

		{#if view.fallback}
			<div class="ph-fallback" role="note">
				This page isn’t available in <b>{view.fallback.from}</b> yet — showing
				<b>{view.fallback.to}</b>.
			</div>
		{/if}

		{#if view.entry.body}
			<div class="ph-body"><Region of={view.entry.body} /></div>
			<CodeChrome />
		{/if}

		{#if suggested && view.trail.suggested.length}
			<nav class="ph-suggested" aria-label="Keep reading">
				<p class="ph-suggested-label">Keep reading</p>
				<ul class="ph-suggested-list">
					{#each view.trail.suggested as r (r.slug)}
						<li>
							<a class="ph-suggested-card" href={r.href}>
								<span class="ph-suggested-title">{r.title}</span>
								{#if r.summary}<span class="ph-suggested-summary">{r.summary}</span>{/if}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		{/if}

		{#if pager}<Pager trail={view.trail} />{/if}
	</article>
	{#if toc && view.headings.length}
		<aside class="ph-aside" aria-label="On this page"><OnThisPage headings={view.headings} /></aside>
	{/if}
</div>
