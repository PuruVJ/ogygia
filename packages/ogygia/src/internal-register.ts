/**
 * The Region-free slice of `ogygia/internal` that the compiler's INJECTED imports reference — the
 * appended-registration helpers (`__register_transportable` per exported class, `__tag_context` per
 * `createContext`) and the macro runtime (`__og_$` / `__og_store` / `__og_boundary`, emitted by the
 * `import.meta.og.$` / `.store` passes). The transform drops an import of these into app modules, so
 * this module is dragged into whatever realm those modules run in.
 *
 * It exists to keep those injections Region-free. The `ogygia/internal` barrel they target also
 * re-exports {@link ./Region.svelte} (which reaches `$app/paths` → Kit's client runtime → `window`).
 * A bundled client build tree-shakes `Region` away when only these helpers are used, but Vite DEV
 * serves raw ESM with no tree-shaking, so the barrel eagerly evaluates `Region.svelte`. In the browser
 * (window present) that's harmless — but the Observatory's compiler worker is a NO-window realm, and a
 * worker-side module that the transform touched then crashes at module-eval. Every re-export below sits
 * on a pure transport/context/boundary leaf that reaches neither `Region` nor `$app/*`, so importing
 * this seam is safe in every realm. (The worker's SSR eval + live preview provide these to user code.)
 */
export { __register_transportable } from './live-transport.js';
export { __tag_context } from './context-bridge.js';
export { __og_$ } from './fn-transport.js';
export { __og_store } from './store-transport.js';
export { __og_boundary } from './boundary.js';
