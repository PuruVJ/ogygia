<script lang="ts">
	// SEED SHAPING fixture (e2e/seed-shape.spec.ts): this island reads exactly ONE top-level key of
	// `page.data` plus `page.url`. The build's analysis pins that read, so the page seed ships `small`
	// and never `big` — the 300 KB the load also returned for the server-only parts of the page.
	import { page } from '$app/state';
	const small = $derived(page.data.small as string);
	const path = $derived(page.url.pathname);
	let n = $state(0);
</script>

<div data-seed-shape-reader>
	<span data-small>{small}</span> at <span data-path>{path}</span>
	<button data-n onclick={() => n++}>n:{n}</button>
</div>
