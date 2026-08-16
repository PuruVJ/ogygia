<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="err">
	<p class="err-code">{page.status}</p>
	<h1 class="err-title">{page.status === 404 ? 'Page not found' : 'Something went wrong'}</h1>
	<p class="err-msg">{page.error?.message ?? 'Unknown error'}</p>
	<a class="err-home" href="/">← Back home</a>
</div>

<style>
	.err {
		max-width: 32rem;
		margin: 0 auto;
		padding: 6rem 1.5rem;
		text-align: center;
	}
	.err-code {
		margin: 0;
		font-size: 3rem;
		font-weight: 800;
		letter-spacing: -0.03em;
		color: var(--og-text-faint, #9096a1);
	}
	.err-title {
		margin: 0.25rem 0 0.5rem;
		font-size: 1.4rem;
	}
	.err-msg {
		margin: 0 0 1.5rem;
		color: var(--og-text-dim, #5b6069);
	}
	.err-home {
		color: var(--og-accent, #6b8afd);
		text-decoration: none;
		font-weight: 600;
	}
</style>
