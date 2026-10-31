# @ogygia/federation

Fragment federation for [ogygia](https://ogygia.puruvj.dev). Independent SvelteKit + ogygia apps combine into one page over HTTP, at render time. A peer's routes and widgets are region values you render with `<Region>`, and a whole app mounts under shell chrome. Every hop is Ed25519-signed, and a publish on one team thaws the frozen pages of every team that baked its fragments.

Experimental: the API can still change.

## Install

Install it in every app that federates, shell and MFE alike. It builds on the server router.

```bash
pnpm add @ogygia/federation @ogygia/router
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { federation } from '@ogygia/federation/vite';

export default defineConfig({
	plugins: [ogygia({ plugins: [federation()] }), sveltekit()]
});
```

## Use

```ts
// src/lib/federation.server.ts (imported by hooks.server.ts)
import { federate } from '@ogygia/federation';

export const { cms } = federate({
	name: 'shell',
	key: env.SHELL_SIGNING_KEY,
	peers: { cms: { origin: 'https://cms.internal', key: env.CMS_PUBLIC_KEY } }
});
```

Then `cms.page(path)` and `cms.widget(name, props)` are regions, and `mount(cms)` mounts the whole app in a route table. Make a key pair with `npx ogygia keys shell`.

Docs: [Fragment federation](https://ogygia.puruvj.dev/docs/app/federation).
