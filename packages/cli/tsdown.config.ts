import { defineConfig } from 'tsdown';
import { library } from '@ogygia/tooling/tsdown';

// [0] the modules the command loads on demand (`mcp`, `perf/*`): unbundled, core left as an import.
// [1] the command itself, `dist/cli.mjs`: ONE self-contained file (sv-utils and its dependencies
//     inlined), so the published package declares no dependency for it; it loads [0] by URL.
export default defineConfig([
	library({ entry: ['src/**/*.ts', '!src/**/*.d.ts', '!src/cli.ts'], dts: false }),
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
