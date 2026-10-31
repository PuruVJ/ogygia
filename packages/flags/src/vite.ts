/**
 * `flags()` — the flags plugin, listed beside `ogygia()` in vite.config `plugins`. Turns on the
 * per-request source priming and exposure flushing (its server realm); `flag()` itself works without
 * it (native, sticky decisions), but a `decide({ source, exposure })` needs it.
 */
import { definePlugin, type OgygiaPlugin } from '@ogygia/core/vite';

export function flags(): OgygiaPlugin {
	return definePlugin({ name: '@ogygia/flags', server: import.meta.resolve('./server.ts') });
}
