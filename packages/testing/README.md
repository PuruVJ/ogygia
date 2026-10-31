# @ogygia/testing

Testing for [ogygia](https://ogygia.puruvj.dev): the devtools and the profiler as test primitives. Your Playwright tests click through the app as usual; ogygia measures hydration, interactions, server time and weight, and your test fails on a budget.

## Install

```bash
pnpm add -D @ogygia/testing @playwright/test
```

It is a test helper, not a plugin. The server under test lists the `devtools()` plugin from `@ogygia/devtools` (and `devtools({ profiler: true })` for `profile()`).

## Use

```ts
// tests/fixtures.ts
import { test as base, expect as baseExpect } from '@playwright/test';
import { withOgygia } from '@ogygia/testing';

export const { test, expect } = withOgygia(base, baseExpect);
```

```ts
test('checkout stays fast', async ({ page, ogygia }) => {
	await page.goto('/cart');
	expect(await ogygia.page()).toMeetBudget({ lcp: 2500, cls: 0.1 });
	expect(await ogygia.hydration()).toHydrateCleanly();
});
```

Docs: [Testing](https://ogygia.puruvj.dev/docs/devtools/testing).
