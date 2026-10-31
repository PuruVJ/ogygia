import { defineConfig } from 'tsdown';
import { library } from '@ogygia/tooling/tsdown';

// [0] the re-exports (every subpath forwards to the same subpath of `@ogygia/core`, left an import).
// [1] the `ogygia` command's front door (`npx ogygia init` → @ogygia/cli), `dist/cli.mjs`: ONE
//     self-contained file, only node builtins external.
export default defineConfig([
	library({ entry: ['src/**/*.ts', '!src/**/*.d.ts', '!src/cli.ts'] }),
	{
		entry: ['src/cli.ts'],
		format: 'esm',
		platform: 'node',
		dts: false,
		clean: false, // the library build [0] cleaned dist/
		treeshake: true,
		deps: {
			alwaysBundle: [/.*/],
			neverBundle: [/^node:/]
		}
	}
]);
