# @ogygia/freeze

Frozen pages for [ogygia](https://ogygia.puruvj.dev). A page whose render read nothing personal renders one time, is stored whole, and is served as bytes until a publish thaws it. Kit, your loads and Svelte never run on a hit. `render: 'deferred'` holes inside a frozen page stay per visitor.

## Install

```bash
pnpm add @ogygia/freeze
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { freeze } from '@ogygia/freeze/vite';

export default defineConfig({
	plugins: [ogygia(), freeze({ ttl: 86400 }), sveltekit()]
});
```

`freeze({ default: false })` makes it opt-in: a page or layout then says `export const freeze = true`.

## Use

```ts
// src/hooks.server.ts — live stores and CDN edges are set up here, not in vite.config
import { freeze, valkey } from '@ogygia/freeze';

freeze.configure({ store: valkey(client) });

await freeze.invalidate('/blog/hello/');            // one URL
await freeze.invalidateWhere({ prefix: '/blog/' }); // a subtree
```

With no `configure()`, pages are kept in an in-process LRU.

Docs: [Frozen pages](https://ogygia.puruvj.dev/docs/data-state/freeze).
