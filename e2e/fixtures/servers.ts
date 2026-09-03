// Boot a server for a spec (a fixture app's adapter-node output, a `vite dev` / `vite preview`, an
// emulator) and tear it down cleanly. The house rules, in one place:
// - `detached: true` → the child is its own process GROUP, so `kill()` reaches the real server even
//   when `cmd` is a wrapper (pnpm → vite); killing only the wrapper orphans the server on the port.
// - readiness is a poll of `url` (any HTTP answer by default — a 404 still means "up").
// - stdout/stderr are captured, and a boot timeout throws WITH the log tail.
import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnServerOptions {
	cmd: string;
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Polled until it answers. */
	url: string;
	timeout_ms?: number;
	/** Custom readiness (default: any HTTP status). */
	ready?: (res: Response) => boolean;
}

export interface SpawnedServer {
	readonly child: ChildProcess;
	readonly logs: string[];
	/** SIGTERM the process group (safe to call twice). */
	kill(): void;
	/** Last N log lines, for a failure message. */
	tail(n?: number): string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function spawn_server(opts: SpawnServerOptions): Promise<SpawnedServer> {
	const logs: string[] = [];
	const child = spawn(opts.cmd, opts.args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	child.stdout?.on('data', (d) => logs.push(String(d)));
	child.stderr?.on('data', (d) => logs.push(String(d)));
	const server: SpawnedServer = {
		child,
		logs,
		kill() {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				/* already gone */
			}
		},
		tail(n = 20) {
			return logs.join('').split('\n').slice(-n).join('\n');
		}
	};
	const ready = opts.ready ?? (() => true);
	const start = Date.now();
	const timeout = opts.timeout_ms ?? 60_000;
	while (Date.now() - start < timeout) {
		if (child.exitCode !== null) {
			throw new Error(
				`server exited early (${opts.cmd} ${opts.args.join(' ')}) — code ${child.exitCode}\n${server.tail()}`
			);
		}
		try {
			const res = await fetch(opts.url, { redirect: 'manual' });
			if (res.status > 0 && ready(res)) return server;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	server.kill();
	throw new Error(`server never came up at ${opts.url} within ${timeout}ms\n${server.tail()}`);
}
