/**
 * The server process, as the freeze plugin sees it — set once by the server realm's `setup`. The
 * app-facing API (`freeze.invalidate`) runs outside any hook and reaches the shared hooks and the
 * devtools stream through it. Null before the plugin starts (a unit test that never starts it):
 * nothing is announced then.
 */
import type { ServerApp } from 'ogygia/plugin';
import type { FreezeServerOptions } from './server.ts';

let current: ServerApp<FreezeServerOptions> | null = null;

export function set_freeze_app(app: ServerApp<FreezeServerOptions> | null): void {
	current = app;
}

export function freeze_app(): ServerApp<FreezeServerOptions> | null {
	return current;
}
