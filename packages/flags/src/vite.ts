/**
 * `flags()` — the flags plugin, for `ogygia({ plugins: [flags()] })` in vite.config. Turns on the
 * per-request source priming and exposure flushing; `flag()` itself works without it (native,
 * sticky decisions), but a `decide({ source, exposure })` needs it.
 *
 * Types only from core: vite.config loads this file in plain node, before any bundler runs.
 */
import type { OgygiaPlugin } from 'ogygia/plugin';

/** The plugin API this package speaks (core's `PLUGIN_API`; a test pins the two together). */
const API = 1;

export function flags(): OgygiaPlugin {
	return { name: 'flags', api: API, server: '@ogygia/flags/server' };
}
