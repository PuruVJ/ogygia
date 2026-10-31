# @ogygia/flags

Feature flags and A/B tests for [ogygia](https://ogygia.puruvj.dev). A kill switch, a rollout, a targeting rule and an A/B/n test are one primitive, `flag()`. It is decided on the server during SSR, so the chosen variant is simply what renders: no flicker, no client SDK, no JS for the decision.

## Install

```bash
pnpm add @ogygia/flags
```

```ts
// vite.config.ts
import { ogygia } from 'ogygia/vite';
import { flags } from '@ogygia/flags/vite';

export default defineConfig({
	plugins: [ogygia({ plugins: [flags()] }), sveltekit()]
});
```

## Use

```ts
import { flag, decide } from '@ogygia/flags';

export const checkout = flag('new-checkout');               // kill switch
export const hero = flag('hero', { control: 80, bold: 20 }); // weighted variants

hero(c); // 'control' | 'bold', sticky per visitor
```

A native `flag()` works without the plugin. The plugin primes a `decide({ source })` (OpenFeature, OFREP, or your own function) one time per request, and drains the `exposure` sink at the end of each request. OpenFeature lives at `@ogygia/flags/openfeature`.

Docs: [Flags & experiments](https://ogygia.puruvj.dev/docs/app/experiments).
