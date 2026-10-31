// Core's e2e suite: the specs in e2e/ against the palaestra (this app), built and served.
//
//   pnpm turbo run e2e --filter=palaestra          # libraries built by turbo, then this suite
//   pnpm --filter palaestra e2e split-brain        # one spec (libraries already built)
//   E2E_NO_BUILD=1 pnpm --filter palaestra e2e     # reuse the existing palaestra build
//
// The webServer BUILDS then SERVES in one shell — `e2e/e2e-build.ts` builds the palaestra (with the
// prerender-secret warn-path probe), then `vite preview` serves that exact build (why not globalSetup:
// see e2e/e2e-build.ts). Specs drive it through the `page` fixture; specs that boot their OWN servers
// (dev servers, fixture apps, adapter emulators) do so in `beforeAll`/`afterAll`.
import { suite } from '@ogygia/tooling/e2e/config.ts';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3051);

export default suite({
	port: PORT,
	serve: fileURLToPath(new URL('.', import.meta.url)),
	command: `node e2e/e2e-build.ts && node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`
});
