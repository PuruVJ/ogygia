#!/usr/bin/env node
/**
 * `ogygia` — the command (`npx ogygia init`, `ogygia mcp`, …) lives in `@ogygia/cli`; this is its
 * front door, so the name everyone types keeps working. It runs the app's installed `@ogygia/cli`
 * (or one beside this package); with none installed, the matching version through the package
 * manager's runner. Nothing else here: no dependency, bundled into one file.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const args = process.argv.slice(2);

/** `@ogygia/cli`'s command, from the app (where it is installed) or from beside this package. */
function installed(): string | null {
	for (const from of [path.join(process.cwd(), 'package.json'), import.meta.url]) {
		try {
			return createRequire(from).resolve('@ogygia/cli/bin');
		} catch {
			/* not there */
		}
	}
	return null;
}

/** The package manager's one-off runner (the one that started us). */
function runner(): [string, string[]] {
	const agent = process.env.npm_config_user_agent ?? '';
	const spec = `@ogygia/cli@${version}`;
	if (agent.startsWith('pnpm')) return ['pnpm', ['dlx', spec]];
	if (agent.startsWith('yarn')) return ['yarn', ['dlx', spec]];
	if (agent.startsWith('bun')) return ['bunx', [spec]];
	return ['npx', ['-y', spec]];
}

const bin = installed();
const [cmd, pre] = bin ? [process.execPath, [bin]] : runner();
const result = spawnSync(cmd, [...pre, ...args], {
	stdio: 'inherit',
	shell: process.platform === 'win32' && !bin
});
process.exit(result.status ?? 1);
