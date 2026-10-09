import { sequence } from '@sveltejs/kit/hooks';
import * as ogygia from 'ogygia/server';
import type { Handle } from '@sveltejs/kit';

// Cross-origin isolation for the Observatory (/observatory + its /observatory-frame iframe). The
// rolldown-browser WASM uses SharedArrayBuffer, which needs COOP: same-origin + COEP: require-corp on
// the document. Scoped to the Observatory routes so the rest of the docs site is never constrained.
//
// NOTE: the worker + .wasm live in /_app/immutable (static assets served by the adapter, NOT this
// handle), so for full PRODUCTION isolation they need matching Cross-Origin-Embedder-Policy /
// Cross-Origin-Resource-Policy headers set at the platform level (e.g. vercel.json `headers`). The vite
// dev/preview server already applies them app-wide (see vite.config.ts), so dev + `vite preview` work.
const crossOriginIsolation: Handle = async ({ event, resolve }) => {
	const res = await resolve(event);
	if (event.url.pathname.startsWith('/observatory')) {
		res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
		res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	}
	return res;
};

// The SSR profiler is configured in vite.config.ts (`profiler: true`) and mounted inside
// ogygia.handle() — not wired here. Without OGYGIA_PROFILER_SECRET the UI hides itself in
// production, so it's inert on deploys.
export const handle = sequence(crossOriginIsolation, ogygia.handle());
