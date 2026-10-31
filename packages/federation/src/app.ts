/**
 * The server process, as the federation plugin sees it — set once by the server realm's `setup`.
 * The app-facing API (`federate()`, a peer handle's loads) runs outside any hook and reaches the
 * request facts, the shared hooks and the app's signer through it. Null before the plugin starts.
 */
import type { ServerApp } from '@ogygia/core/plugin';

let current: ServerApp | null = null;

export function set_fed_app(app: ServerApp | null): void {
	current = app;
}

export function fed_app(): ServerApp | null {
	return current;
}
