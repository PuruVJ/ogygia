# @ogygia/devtools

Devtools for [ogygia](https://ogygia.puruvj.dev): the in-page dock (each region boxed on the page, its real JS cost, what crossed the wire, when each island woke) and the SSR profiler (why a server render is slow, at `/__profiler`).

## Install

```bash
pnpm add @ogygia/devtools
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { devtools } from '@ogygia/devtools/vite';

export default defineConfig(({ mode }) => ({
	plugins: [ogygia(), ...(mode !== 'production' ? [devtools({ profiler: true })] : []), sveltekit()]
}));
```

- `dock` (default `true`): the dock. On the dev server a launcher shows on every page. In a build it stays hidden until a browser turns it on with `?og-devtools=on`.
- `profiler` (default off): `true` or its options. In production, set `OGYGIA_PROFILER_SECRET`.

Code for the profiler: `@ogygia/devtools/profiler` (`span`, `instrument`), `@ogygia/devtools/profiler/client` (`mark`), and stores at `@ogygia/devtools/profiler/storage/sqlite`, `/redis`, `/postgres`.

Docs: [Devtools](https://ogygia.puruvj.dev/docs/devtools/overview) and [the profiler](https://ogygia.puruvj.dev/docs/profiler/overview).
