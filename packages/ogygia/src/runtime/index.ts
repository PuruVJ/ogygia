/**
 * Browser sticky runtime entry. The ogygia compiler injects `import { bootDev } from 'ogygia/runtime';
 * bootDev()` for the dev / no-marks build (kitchen-sink — every feature). A per-app production build
 * instead points the entry at a generated module (see `vite/runtime-entry.ts`) that boots only the
 * features it uses.
 *
 * This is a plain RE-EXPORT, not a side-effect import — the boot is an explicit `bootDev()` call the
 * compiler emits, so it can never be tree-shaken (or dropped by Vite's dep prebundler) the way a bare
 * `import './full.js'` could. Manual (no-plugin) users call `bootDev()` themselves.
 */
export { bootDev } from './full.js';
