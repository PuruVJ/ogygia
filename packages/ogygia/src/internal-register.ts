/**
 * The compiler's appended-registration seam — `__register_transportable` (one call per exported class)
 * and `__tag_context` (one per `createContext`). The transform injects an import of these into EVERY
 * app module that has an exported class or a `createContext`, so this module is dragged into whatever
 * realm that module runs in.
 *
 * It exists to keep that injection Region-free. The `ogygia/internal` barrel it used to target also
 * re-exports {@link ./Region.svelte} (which reaches `$app/paths` → Kit's client runtime → `window`).
 * A bundled client build tree-shakes `Region` away when only these two helpers are used, but Vite DEV
 * serves raw ESM with no tree-shaking, so the barrel eagerly evaluates `Region.svelte`. In the browser
 * (window present) that's harmless — but the Observatory's compiler worker is a NO-window realm, and a
 * worker-side module that the transform touched (its own `export class` machinery) then crashes at
 * module-eval. Both helpers below sit on pure transport/context leaves that reach neither `Region` nor
 * `$app/*`, so importing this seam is safe in every realm.
 */
export { __register_transportable } from './live-transport.js';
export { __tag_context } from './context-bridge.js';
