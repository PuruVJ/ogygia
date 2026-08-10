<script lang="ts">
	// Classic SvelteKit form actions on a csr=false page: the <form> submits NATIVELY (a real
	// document POST), works with zero JS, and the SPA router does not intercept it (the router
	// only handles <a> clicks). Successful submits use post-redirect-get.
	// A Counter island is present so the runtime (and SPA router) are active — proving the form
	// still submits natively even with the router running.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import GuestbookForm from '$lib/GuestbookForm.svelte' with { wake: 'load' };
	let { data, form } = $props();
</script>

<h1 data-static-shell>Guestbook — classic form actions</h1>
<Counter start={0} label="island on the forms page (router active)" />

<h2 data-static-shell>Remote form (inside an island)</h2>
<GuestbookForm />
<p data-static-shell>Plain <code>&lt;form method="POST"&gt;</code>. No JS needed; works with the SPA router active.</p>

{#if data.ok}<p data-form-ok>Thanks — your entry was saved.</p>{/if}
{#if form?.error}<p data-form-error>{form.error}</p>{/if}

<form method="POST" action="?/add" data-guestbook-form>
	<input name="name" placeholder="your name" value={form?.name ?? ''} data-input-name />
	<input name="message" placeholder="a message" value={form?.message ?? ''} data-input-message />
	<button type="submit" data-submit>Sign the guestbook</button>
</form>

<ul data-entries>
	{#each data.entries as e (e.at.toISOString() + e.name)}
		<li data-entry>{e.name}: {e.message}</li>
	{/each}
</ul>
