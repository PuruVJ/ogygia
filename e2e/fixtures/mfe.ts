// Worker fixture: the three examples/mfe apps as `vite dev` servers (the shell mounts cms, cms
// stitches dash), with throwaway Ed25519 keys so the signature gate stays on. Boots once per worker,
// torn down after the last test. Dev mode on purpose: dev-only warnings ship stripped from a
// production island bundle.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export const HOST = '127.0.0.1';
export const PORTS = { shell: 5190, dash: 5191, cms: 5192 } as const;
export type App = keyof typeof PORTS;
export const origin = (app: App) => `http://${HOST}:${PORTS[app]}`;

export interface MfeServers {
	origin: (app: App) => string;
	/** Captured stdout/stderr per app, for a failure report. */
	logs: Record<App, string[]>;
	/** The throwaway Ed25519 keypairs, so a test can sign a hop/notice AS a given team. */
	keys: Record<App, { pub: string; priv: string }>;
}

const pair = () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
		priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
	};
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until_up(app: App, path: string, ms = 120_000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			const res = await fetch(origin(app) + path, { headers: { accept: 'text/html' } });
			if (res.ok) return true;
		} catch {
			/* not yet */
		}
		await sleep(500);
	}
	return false;
}

export const test = base.extend<Record<never, never>, { mfe: MfeServers }>({
	mfe: [
		async ({}, use) => {
			const shell_keys = pair();
			const cms_keys = pair();
			const dash_keys = pair();
			// v2 federation: EVERY app both calls and answers, so all three publics + all three
			// origins reach each app; each app also holds its OWN private signing key.
			const common = {
				SHELL_PUBLIC_KEY: shell_keys.pub,
				CMS_PUBLIC_KEY: cms_keys.pub,
				DASH_PUBLIC_KEY: dash_keys.pub,
				SHELL_ORIGIN: origin('shell'),
				CMS_ORIGIN: origin('cms'),
				DASH_ORIGIN: origin('dash')
			};
			const keys: Record<App, { pub: string; priv: string }> = {
				shell: shell_keys,
				cms: cms_keys,
				dash: dash_keys
			};
			const env_for: Record<App, Record<string, string>> = {
				dash: { ORIGIN: origin('dash'), DASH_SIGNING_KEY: dash_keys.priv, ...common },
				cms: { ORIGIN: origin('cms'), CMS_SIGNING_KEY: cms_keys.priv, ...common },
				shell: { ORIGIN: origin('shell'), SHELL_SIGNING_KEY: shell_keys.priv, ...common }
			};
			const procs: Partial<Record<App, ChildProcess>> = {};
			const logs: Record<App, string[]> = { shell: [], dash: [], cms: [] };
			// detached = own process GROUP so teardown kills the real vite child (killing the pnpm
			// wrapper alone orphans vite on the port); `--host 127.0.0.1` pins IPv4.
			for (const app of ['dash', 'cms', 'shell'] as App[]) {
				const p = spawn(
					'pnpm',
					[
						'--filter',
						`mfe-${app}`,
						'exec',
						'vite',
						'dev',
						'--port',
						String(PORTS[app]),
						'--host',
						HOST
					],
					{
						cwd: repo,
						env: { ...process.env, ...env_for[app] },
						stdio: ['ignore', 'pipe', 'pipe'],
						detached: true
					}
				);
				p.stdout?.on('data', (d) => logs[app].push(String(d)));
				p.stderr?.on('data', (d) => logs[app].push(String(d)));
				procs[app] = p;
			}
			const kill_all = () => {
				for (const p of Object.values(procs)) {
					if (!p?.pid) continue;
					try {
						process.kill(-p.pid, 'SIGTERM');
					} catch {
						/* already gone */
					}
				}
			};
			try {
				const up = await Promise.all([
					until_up('dash', '/'),
					until_up('cms', '/cms/'),
					until_up('shell', '/')
				]);
				if (!up.every(Boolean)) {
					const tails = (['shell', 'cms', 'dash'] as App[])
						.map((a) => `--- ${a} ---\n${logs[a].join('').split('\n').slice(-12).join('\n')}`)
						.join('\n');
					throw new Error(
						`mfe dev servers did not come up (dash/cms/shell = ${up.join('/')})\n${tails}`
					);
				}
				await use({ origin, logs, keys });
			} finally {
				kill_all();
			}
		},
		{ scope: 'worker', timeout: 240_000 }
	]
});

export { expect } from '@playwright/test';
