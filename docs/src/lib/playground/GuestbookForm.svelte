<script lang="ts">
	// Remote form() INSIDE an island — Kit's own client form runtime, reused by ogygia. Enhanced
	// submit (no reload), per-field issues, and pending state all work; with JS off the form posts
	// natively to the remote endpoint and post-redirect-gets back. On submit we single-flight the
	// `getEntries` query so the list below refreshes in the same round-trip.
	import { signGuestbook, getEntries } from '$lib/playground/guestbook.remote';

	const entries = getEntries();
</script>

<div class="widget" data-guestbook style="max-width: 340px;">
	<span class="widget-label">remote form() · guestbook</span>

	<form
		{...signGuestbook.enhance(async ({ submit }) => {
			await submit();
			await entries.refresh(); // re-read the query so the list below reflects the new entry
		})}
		data-remote-form
		class="gb-form"
	>
		<label class="gb-field">
			<input {...signGuestbook.fields.name.as('text')} placeholder="name" data-rf-name />
			{#each signGuestbook.fields.name.issues() ?? [] as issue}
				<span class="gb-issue" data-rf-name-issue>{issue.message}</span>
			{/each}
		</label>
		<label class="gb-field">
			<input {...signGuestbook.fields.message.as('text')} placeholder="message" data-rf-message />
			{#each signGuestbook.fields.message.issues() ?? [] as issue}
				<span class="gb-issue" data-rf-message-issue>{issue.message}</span>
			{/each}
		</label>
		<button type="submit" data-rf-submit>
			{signGuestbook.pending ? 'signing…' : 'Sign'}
		</button>
	</form>

	{#if signGuestbook.result?.ok}
		<p class="widget-meta" data-rf-result>Signed! total {signGuestbook.result.total}</p>
	{/if}

	<svelte:boundary>
		<ul class="gb-entries" data-gb-entries>
			{#each await entries as e}
				<li><strong>{e.name}</strong> — {e.message}</li>
			{/each}
		</ul>
		{#snippet pending()}<p class="widget-meta">loading entries…</p>{/snippet}
	</svelte:boundary>
</div>

<style>
	.gb-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.gb-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.gb-form input {
		width: 100%;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: var(--bg-raised);
		color: var(--text);
		font: 400 0.8125rem/1.4 var(--font-body);
	}
	.gb-form input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.gb-issue {
		font: 400 0.6875rem/1.3 var(--font-mono);
		color: var(--warn);
	}
	.gb-entries {
		margin: 0.875rem 0 0;
		padding-left: 1.1rem;
		font: 400 0.75rem/1.6 var(--font-mono);
		color: var(--text-dim);
	}
	.gb-entries strong {
		color: var(--accent);
		font-weight: 500;
	}
</style>
