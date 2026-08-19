<script>
	// Cross-island context provider for PLAIN `getContext(key)` — no `createContext` handle needed, no
	// change to the consumer islands. Writes `values` into the DOM once (so islands below, which
	// hydrate as separate roots on a csr=false page, get them seeded into their own context at hydrate)
	// AND sets Svelte's native context (so the SSR-nested tree + any non-island descendants read the
	// same values in the server pass). Values must be SERIALIZABLE (devalue + ogygia codecs): plain
	// data, `[ogygia.wire]` live values, region snippets — never a function or a live store.
	import { setContext } from 'svelte';
	import { serialize_context } from './context-bridge.js';

	/**
	 * @type {{
	 *   values: Record<string, unknown> | Array<Record<string, unknown> | false | null | undefined>,
	 *   children?: import('svelte').Snippet
	 * }}
	 */
	let { values, children } = $props();

	// clsx-like: an object is used as-is; an array is flattened + merged left→right (falsy entries
	// skipped, later keys win). A typed `createContext('k')('v')` returns `{ k: 'v' }`, so typed and
	// raw entries mix freely: `values={[ { locale }, theme('dark'), cond && { x: 1 } ]}`.
	// A provider's values are fixed for its lifetime — resolved once (server pass).
	// svelte-ignore state_referenced_locally
	const resolved = Array.isArray(values)
		? /** @type {Record<string, unknown>} */ (Object.assign({}, ...values.filter(Boolean)))
		: values;

	// svelte-ignore state_referenced_locally
	for (const k in resolved) setContext(k, resolved[k]);

	// Angle brackets built without literals so Svelte's raw-text lexer never sees a stray tag.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);
	// Serialize on the SERVER only — a csr=false provider never runs on the client; the payload is
	// already in the SSR HTML for islands to read at hydrate.
	// svelte-ignore state_referenced_locally
	const script =
		typeof window === 'undefined'
			? LT + 'script data-ogygia-provide' + GT + serialize_context(resolved) + LT + '/script' + GT
			: '';
</script>

<ogygia-provide style="display:contents">{@html script}{@render children?.()}</ogygia-provide>
