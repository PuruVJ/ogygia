/**
 * The server process, as the flags plugin sees it — set once by the server realm's `setup`. Null in
 * a browser bundle (the server realm is never imported there) and in a unit test that does not
 * start the plugin: reads then record nothing.
 */
import type { ServerApp } from '@ogygia/core/plugin';

let current: ServerApp | null = null;

export function set_flags_app(app: ServerApp | null): void {
	current = app;
}

export function flags_app(): ServerApp | null {
	return current;
}
