# @ogygia/tsdown-plugin-svelte

Ship Svelte components from a [tsdown](https://tsdown.dev) build, the way `svelte-package` does, without giving up tsdown for the rest of your library.

- Every `.svelte` file in `src` is copied to `dist` at the same path, **not compiled**. Your users' own Svelte compiles it, so your library never locks in a Svelte version.
- TypeScript is removed from the script **and the template**. Write `{x as Item}`, `{a!.b}` or `{#snippet row(item: Item)}` freely. What ships is plain JS, so users need no TypeScript setup.
- A `.svelte.d.ts` is generated next to each component, so users get typed props.
- Plain `.css` files in `src` are copied too.

## Install

```sh
pnpm add -D @ogygia/tsdown-plugin-svelte svelte2tsx typescript @sveltejs/vite-plugin-svelte
```

`svelte2tsx` and `typescript` are only needed for types. `@sveltejs/vite-plugin-svelte` is only needed for the default preprocessor.

## Use

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown';
import { svelte } from '@ogygia/tsdown-plugin-svelte';

export default defineConfig({
	entry: ['src/**/*.ts'],
	unbundle: true,
	dts: true,
	plugins: [svelte()],
	// keep the shipped components external
	deps: { neverBundle: ['svelte', /\.svelte$/] }
});
```

## Options

| option       | default                           | what it does                                         |
| ------------ | --------------------------------- | ---------------------------------------------------- |
| `root`       | `process.cwd()`                   | the package root the other paths start from          |
| `src`        | `'src'`                           | where the components live                            |
| `out`        | `'dist'`                          | where they go (match tsdown's `outDir`)              |
| `preprocess` | `vitePreprocess({ script: true })` | preprocessors for script and style                   |
| `dts`        | `true`                            | write a `.svelte.d.ts` next to each component        |

## Just the TypeScript strip

```ts
import { preprocess } from 'svelte/compiler';
import { strip_markup_ts } from '@ogygia/tsdown-plugin-svelte';

const { code } = await preprocess(source, preprocessors, { filename });
const plain_js = strip_markup_ts(code, filename);
```

It uses Svelte's own parser, so it only ever removes type syntax, never a look-alike in a string or comment.

## License

MIT
