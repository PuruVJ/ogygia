// Test stub for `virtual:ogygia/hydrate-features` (the real one is generated from the app's marks by
// the compiler, link/runtime-entry.ts): every hydrate-phase feature, like the dev build.
import * as context from '../../src/runtime/context.js';
import * as live from '../../src/runtime/live.js';
import * as wire from '../../src/live-transport.js';
import * as remote_seeds from '../../src/runtime/remote-seeds.js';

export function install(): void {
	remote_seeds.install();
	wire.install();
	live.install();
	context.install();
}
