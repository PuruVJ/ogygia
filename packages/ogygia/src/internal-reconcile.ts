/**
 * The SPA-nav reconciler + its child-morph — a CLIENT-ONLY internal surface. The router drives these
 * on `document.body`; exposed here (a subpath, NOT the SSR-loaded `ogygia/internal` barrel, because
 * `reconcile`/`morph` touch the DOM `Node` global at module load) so a harness — the Observatory's
 * in-preview navigation — can drive the SAME reconcile on ANY subtree, getting real
 * keep/patch/mount/remove (a kept island's live state survives the nav).
 *
 * @internal
 */
export { reconcile_body } from './runtime/reconcile.js';
export { morph_children } from './runtime/morph.js';
