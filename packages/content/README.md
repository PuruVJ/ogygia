# @ogygia/content

Content for [ogygia](https://ogygia.puruvj.dev): typed content collections, markdown with mdsvex and Shiki, the docs and blog shells, search, and the content macros (`import.meta.og.loader`, `og.code`, `og.md`). Collections live on the server; only plain data crosses the wire, and bodies render as regions.

## Install

```bash
pnpm add @ogygia/content
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { content } from '@ogygia/content/vite';

export default defineConfig({
	plugins: [ogygia({ plugins: [content({ markdown: {} })] }), sveltekit()]
});
```

```js
// svelte.config.js — markdown files compile through these
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocess, extensions } from '@ogygia/content/vite';

export default {
	extensions: extensions(),
	preprocess: [vitePreprocess(), ...preprocess()]
};
```

```ts
// src/ogygia.d.ts
/// <reference types="ogygia/types" />
/// <reference types="@ogygia/content/types" />
```

## Use

```ts
// src/lib/docs.server.ts
import { content } from '@ogygia/content';

export const docs = content({ loader: import.meta.og.loader.markdown('../content/docs') });
```

`get(id)` gives the entry with its body as a region. The wire layer (`remotes`, `withRemotes`) is `@ogygia/content/remote`; markdown helpers are `@ogygia/content/markdown`; the shell is `@ogygia/content/docs-shell`.

Docs: [Content collections](https://ogygia.puruvj.dev/docs/content/collections).
