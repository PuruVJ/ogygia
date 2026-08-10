<script>
	// Cross-island context provider. Writes `value` into the DOM at this spot (so islands below can
	// read it after the split) AND sets Svelte's native context (so SSR-nested islands see it in the
	// server pass). `of` is a `createContext()` handle; its build-assigned tag is the DOM key.
	import { setContext } from 'svelte';
	import { context_tag, serialize_context } from './context-bridge.js';

	/** @type {{ of: unknown, value: unknown, children?: import('svelte').Snippet }} */
	let { of: ctx, value, children } = $props();

	// A provider's identity and value are fixed for its lifetime — these reads are once-only
	// by design (the DOM payload and native context are written a single time at setup).
	// svelte-ignore state_referenced_locally
	const tag = context_tag(ctx);
	// Native context for the server render (islands are nested in the page tree there).
	// svelte-ignore state_referenced_locally
	setContext(tag, value);

	// Angle brackets built without literals so Svelte's raw-text lexer never sees a stray tag.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);
	// Serialize only on the server — a csr=false provider never runs on the client, and the payload
	// is already in the SSR HTML for islands to read.
	// svelte-ignore state_referenced_locally
	const script =
		typeof window === 'undefined'
			? LT + 'script data-ogygia-ctx' + GT + serialize_context(value) + LT + '/script' + GT
			: '';
</script>

<ogygia-context {tag} ctx={tag} style="display:contents">{@html script}{@render children?.()}</ogygia-context>
