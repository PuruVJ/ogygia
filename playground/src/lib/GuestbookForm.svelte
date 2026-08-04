<script lang="ts">
	// Remote `form()` INSIDE an island — Kit's own client form runtime (reused via ogygia).
	// Enhanced submit (no reload), schema field issues, and pending state all work; with no JS
	// the form posts to the remote endpoint and post-redirect-gets back.
	import { signGuestbook } from '$lib/guestbook.remote';
</script>

<form {...signGuestbook} data-remote-form>
	<input {...signGuestbook.fields.name.as('text')} placeholder="name" data-rf-name />
	{#each signGuestbook.fields.name.issues() ?? [] as issue}
		<span data-rf-name-issue>{issue.message}</span>
	{/each}
	<input {...signGuestbook.fields.message.as('text')} placeholder="message" data-rf-message />
	{#each signGuestbook.fields.message.issues() ?? [] as issue}
		<span data-rf-message-issue>{issue.message}</span>
	{/each}
	<button data-rf-submit>Sign (remote form)</button>
	{#if signGuestbook.pending}<span data-rf-pending>saving…</span>{/if}
</form>

{#if signGuestbook.result?.ok}
	<p data-rf-result>Signed via remote form! total {signGuestbook.result.total}</p>
{/if}
