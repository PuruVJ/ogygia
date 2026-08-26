/**
 * `context` feature — the cross-island context bridge.
 *
 * Fills {@link ./slots.js slots.context} with the DOM walk that seeds each island's `getContext`
 * from a `<Provide>` / drop-in-`setContext` marker above it (see `../context-bridge.js`). Included
 * only when the build detects an ogygia context provider — `Provide`, `setContext`, or
 * `createContext` imported from `'ogygia'` (see the driver's `source_uses_ogygia_context`). A plain
 * app that never bridges context tree-shakes the ~4.7 kB bridge away; core reads the slot with
 * optional chaining, so its absence is just "no provider above" — the common, already-handled case.
 */
import { collect_provided_context } from '../context-bridge.js';
import { slots } from './slots.js';

export function install(): void {
	slots.context = collect_provided_context;
}
