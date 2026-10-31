/**
 * `flags()` — the flags plugin, for `ogygia({ plugins: [flags()] })` in vite.config. Turns on the
 * per-request source priming and exposure flushing (its server realm, `@ogygia/flags/server`, found
 * by name); `flag()` itself works without it (native, sticky decisions), but a
 * `decide({ source, exposure })` needs it.
 */
import { definePlugin, type OgygiaPlugin } from 'ogygia/vite';

export function flags(): OgygiaPlugin {
	return definePlugin({ name: '@ogygia/flags' });
}
