import { defineConfig } from 'vitest/config';

// Unit tests for the pure library internals (the transform). They import the BUILT
// `dist/` output, so root `pnpm run check` builds the lib before invoking `vitest run`
// (via the package `check` script). vitest 4 pairs with vite 8 / Rolldown — its `vite`
// peer range is `^6 || ^7 || ^8`, verified empirically against the workspace vite 8.2.0.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
