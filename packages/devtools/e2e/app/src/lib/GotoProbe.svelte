<script lang="ts">
	// An island that navigates with `goto` from `$app/navigation` — placed on a csr=false page
	// (ogygia's router must swap the page) AND on the csr=true /kit page (Kit's router must, through
	// the kit-page thread; the ogygia router does not own that document and could only reload it).
	// e2e/kit-island-goto.spec.ts.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	let { to }: { to: string } = $props();
</script>

<button class="island" data-goto-probe onclick={() => goto(to)}>goto {to}</button>
<span data-goto-probe-search>{page.url.search}</span>
