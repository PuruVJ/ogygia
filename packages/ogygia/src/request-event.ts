/**
 * `requestEvent()` — the request a server island is rendering for.
 *
 * A `render: 'deferred'` island renders on the origin, under the app's hooks, in the request that
 * fetches it: the visitor's cookies, `locals`, `url` are all there. Kit's own `getRequestEvent()`
 * (`$app/server`) would hand them over — but a component may not import `$app/server`, or any
 * `$lib/server/*` module: the moment a csr=true page shares the layout, that component is in the
 * CLIENT module graph and Kit's guard fails the build. Remote functions were the other channel;
 * an app that has not adopted them has none.
 *
 * This is that channel, isomorphic by construction: on the server every render root ogygia starts
 * carries the live event in Kit's `__request__` context (server/kit-context.ts); on the client the
 * context has none and the call answers `null`. Read it during component init, like `getContext`.
 *
 * ```svelte
 * <script lang="ts">
 *   import { requestEvent } from 'ogygia';
 *   import type { RequestEvent } from '@sveltejs/kit';
 *   const event = requestEvent<RequestEvent>();
 *   const user = event?.locals.user ?? null;   // what hooks.server.ts resolved from the cookie
 * </script>
 * ```
 */
import { getContext } from 'svelte';
import { KIT_REQUEST_CONTEXT } from './server/kit-context.js';

export function requestEvent<E = unknown>(): E | null {
	try {
		const ctx = getContext(KIT_REQUEST_CONTEXT) as { event?: E | null } | undefined;
		return ctx?.event ?? null;
	} catch {
		// outside component init (no context available) — same answer as the client leg
		return null;
	}
}
