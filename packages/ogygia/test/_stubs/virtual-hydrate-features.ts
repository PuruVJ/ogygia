// Test stub for `virtual:ogygia/hydrate-features` (the real one is generated from the app's marks by
// the compiler, link/runtime-entry.ts): every hydrate-phase feature, like the dev build.
import * as context from '../../src/runtime/context.ts';
import * as live from '../../src/runtime/live.ts';
import * as wire from '../../src/live-transport.ts';
import * as remote_seeds from '../../src/runtime/remote-seeds.ts';

export function install(): void {
	remote_seeds.install();
	wire.install();
	live.install();
	context.install();
}
