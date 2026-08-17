<script lang="ts">
	// Styled error page. On a csr=false route the normal page/layout CSS is not fully collected
	// onto the error render, so this component re-imports the site chrome AND carries a scoped
	// style block — scoped component styles are always inlined into the SSR head, so the error
	// page can never render unstyled, whatever else fails to load.
	import { page } from '$app/state';
	import '$lib/styles/site-chrome.css';

	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? 'Something went wrong.');
	const isNotFound = $derived(status === 404);
</script>

<svelte:head>
	<title>{status} · ogygia</title>
</svelte:head>

<main class="err">
	<p class="err-code">{status}</p>
	<h1 class="err-title">{isNotFound ? 'Page not found' : 'Something went wrong'}</h1>
	<p class="err-message">
		{#if isNotFound}
			That page has moved or never existed. It may have been reorganized — try the docs home.
		{:else}
			{message}
		{/if}
	</p>
	<div class="err-actions">
		<a class="err-btn err-btn--primary" href="/">Home</a>
		<a class="err-btn" href="/docs/start/overview">Docs</a>
	</div>
</main>

<style>
	.err {
		max-width: 34rem;
		margin: 0 auto;
		padding: clamp(3rem, 12vh, 8rem) 1.5rem;
		text-align: center;
		font-family: var(--font-sans, system-ui, sans-serif);
		color: var(--text, #1a1a1a);
	}
	.err-code {
		margin: 0;
		font: 600 clamp(3rem, 12vw, 5rem) / 1 var(--font-serif, ui-serif, Georgia, serif);
		font-style: italic;
		color: var(--accent, #2f7d5b);
		letter-spacing: -0.02em;
	}
	.err-title {
		margin: 0.25rem 0 0.75rem;
		font: 600 1.5rem/1.2 var(--font-sans, system-ui, sans-serif);
		color: var(--text, inherit);
	}
	.err-message {
		margin: 0 0 2rem;
		font-size: 1rem;
		line-height: 1.6;
		color: var(--text-faint, #6b7280);
	}
	.err-actions {
		display: flex;
		gap: 0.75rem;
		justify-content: center;
	}
	.err-btn {
		display: inline-flex;
		align-items: center;
		padding: 0.55rem 1.1rem;
		border: 1px solid var(--line, #d1d5db);
		border-radius: var(--r-md, 10px);
		font: 500 0.95rem/1 var(--font-sans, system-ui, sans-serif);
		color: var(--text, inherit);
		text-decoration: none;
		transition: background 0.15s ease;
	}
	.err-btn:hover {
		background: var(--bg-sunken, rgba(127, 127, 127, 0.08));
	}
	.err-btn--primary {
		background: var(--accent, #2f7d5b);
		border-color: var(--accent, #2f7d5b);
		color: #fff;
	}
	.err-btn--primary:hover {
		background: var(--accent-deep, #276448);
	}
</style>
