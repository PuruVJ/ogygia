# @ogygia/router

The server router for [ogygia](https://ogygia.puruvj.dev): SvelteKit's routing model as values. Pages, layouts, loads, actions, endpoints and streamed pages in one typed table, with `App['/path']` types and no codegen. It also ships a typed fetch client for your endpoints.

## Install

```bash
pnpm add @ogygia/router
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { router } from '@ogygia/router/vite';

export default defineConfig({
	plugins: [ogygia(), router(), sveltekit()]
});
```

The plugin links the CSS of every component the table's pages render.

## Use

```ts
// src/lib/router.ts
import { routes, page } from '@ogygia/router';

export const router = routes({ '/': page(Home), '/docs/[slug]': page(Doc, { load }) });
export type App = typeof router.$infer;
```

```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import * as ogygia from 'ogygia/server';

export const handle = sequence(ogygia.handle(), router.handle);
```

The typed client is `api<App>()` from `@ogygia/router/api` (browser-safe).

Docs: [Server router](https://ogygia.puruvj.dev/docs/app/server-router).
