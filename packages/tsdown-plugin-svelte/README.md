# @ogygia/tsdown-plugin-svelte

[![npm](https://img.shields.io/npm/v/@ogygia/tsdown-plugin-svelte)](https://www.npmjs.com/package/@ogygia/tsdown-plugin-svelte)
[![license](https://img.shields.io/npm/l/@ogygia/tsdown-plugin-svelte)](./LICENSE)

Ship Svelte components from a [tsdown](https://tsdown.dev) build.

Keep one build for your whole library. Your `.ts` goes through tsdown as usual, and your `.svelte` components ship next to it, the way `svelte-package` ships them, with no second build step.

```
src/                         dist/
├─ index.ts           →      ├─ index.mjs + index.d.mts        (tsdown)
├─ Button.svelte      →      ├─ Button.svelte                  (plain JS, uncompiled)
│                            ├─ Button.svelte.d.ts             (typed props)
└─ theme.css          →      └─ theme.css                      (copied)
```

## Why

- **Components ship uncompiled.** Each `.svelte` file lands in `dist` at the same path, as source. Your users' own Svelte compiles it, so your library never pins them to the Svelte version you built with.
- **Write TypeScript everywhere, ship plain JS.** TypeScript is removed from the `<script>` and from the template: `{item as Row}`, `{user!.name}` and `{#snippet row(item: Row)}` are all fine. What ships needs no TypeScript setup on the user's side.
- **Typed props.** A `.svelte.d.ts` is generated beside every component, with svelte2tsx, the same engine `svelte-package` uses.
- **Safe stripping.** Types are found with Svelte's own parser, not with patterns, so a string or comment that merely looks like a type is never touched.
- **Styles come along.** Plain `.css` files under `src` are copied as they are.

## Install

```sh
pnpm add -D @ogygia/tsdown-plugin-svelte
```

It needs `tsdown` (0.15 or newer) and `svelte` 5. For the defaults, also install:

```sh
pnpm add -D svelte2tsx typescript @sveltejs/vite-plugin-svelte
```

- `svelte2tsx` and `typescript` generate the `.svelte.d.ts` types. Skip them with `dts: false`.
- `@sveltejs/vite-plugin-svelte` provides the default preprocessor. Skip it by passing your own `preprocess`.

## Usage

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown';
import { svelte } from '@ogygia/tsdown-plugin-svelte';

export default defineConfig({
	entry: ['src/**/*.ts'],
	unbundle: true,
	dts: true,
	plugins: [svelte()],
	// the shipped components stay as files: never bundle them, or Svelte, into your JS
	deps: { neverBundle: ['svelte', /\.svelte$/] }
});
```

`unbundle: true` keeps one output file per source file, so `import Button from './Button.svelte'` in your `.ts` still points at the shipped component.

Then expose the components to Svelte-aware tools with the `svelte` export condition:

```jsonc
// package.json
{
	"type": "module",
	"exports": {
		".": {
			"types": "./dist/index.d.mts",
			"svelte": "./dist/index.mjs",
			"default": "./dist/index.mjs"
		},
		"./Button.svelte": {
			"types": "./dist/Button.svelte.d.ts",
			"svelte": "./dist/Button.svelte"
		}
	},
	"files": ["dist"]
}
```

## Options

```ts
svelte({
	root: process.cwd(),
	src: 'src',
	out: 'dist',
	preprocess: vitePreprocess({ script: true }),
	dts: true
});
```

| Option       | Default                            | What it does                                                    |
| ------------ | ---------------------------------- | --------------------------------------------------------------- |
| `root`       | `process.cwd()`                    | The package root that `src` and `out` are relative to.          |
| `src`        | `'src'`                            | Where your components and `.css` files live.                    |
| `out`        | `'dist'`                           | Where they are written. Match tsdown's `outDir`.                |
| `preprocess` | `vitePreprocess({ script: true })` | Svelte preprocessors for the script and styles (one or a list). |
| `dts`        | `true`                             | Write a `.svelte.d.ts` beside each component.                   |

In a monorepo, set `root` to the package's own folder when tsdown runs from somewhere else:

```ts
svelte({ root: fileURLToPath(new URL('.', import.meta.url)) });
```

## How it works

1. At the start of the build, every `.svelte` under `src` is run through your preprocessors, which turns its `<script lang="ts">` into JS.
2. Svelte's parser then reads the file once more, still as TypeScript, and every type-only span in the template is cut out: `as` and `satisfies` casts, `!` assertions, annotations and generic arguments. `lang="ts"` is removed from each script.
3. The result is emitted as a build asset at the same path in `out`. Emitting assets, rather than writing files, means tsdown's `clean` never wipes them.
4. After the bundle is written, svelte2tsx generates declarations into a scratch folder, and only the `*.svelte.d.ts` files are copied next to the components. tsdown keeps owning the declarations for your `.ts` files.

## Using the TypeScript strip on its own

`strip_markup_ts` is exported for tools that ship Svelte source another way. Run it on the output of `preprocess()`, when the script is JS but the template still has types:

```ts
import { preprocess } from 'svelte/compiler';
import { strip_markup_ts } from '@ogygia/tsdown-plugin-svelte';

const { code } = await preprocess(source, preprocessors, { filename });
const plain_js = strip_markup_ts(code, filename);
```

## License

[MIT](./LICENSE)
