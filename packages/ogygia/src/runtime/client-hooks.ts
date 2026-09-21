/**
 * Run the app's `hooks.client.ts` `init()` on a csr=false page.
 *
 * SvelteKit runs `hooks.client.ts` (its top-level code and the `init` hook) only when its own client
 * app boots. A `csr = false` page never boots that app — ogygia hydrates islands directly — so
 * anything that file starts (a monitoring/RUM agent, a third-party component bootstrap) would silently
 * never load, and the page behaves differently with ogygia than without. ogygia IS the client
 * bootstrap on those pages, so it runs the hook itself, giving `hooks.client.ts` the same effect it has
 * on a csr=true page.
 *
 * On a Kit (csr=true) document Kit already ran the file — this SKIPS, so `init` never double-fires.
 * Fire-and-forget and after paint: a failing `init` warns but never blocks island hydration, and the
 * dynamic import means the file (and its deps) load only where Kit didn't — never on a csr=true page.
 */
import { KitBoot } from './kit-boot.js';

type ClientHooksModule = { init?: (input?: unknown) => unknown };

export function run_app_client_hooks(loader: () => Promise<ClientHooksModule>): void {
	if (typeof document === 'undefined') return;
	// csr=true document → Kit boots and runs hooks.client itself; do not run it again.
	if (KitBoot.document_has(document)) return;
	Promise.resolve()
		.then(loader)
		.then((m) => m.init?.())
		.catch((e) => console.error('[ogygia] hooks.client init failed:', e));
}
