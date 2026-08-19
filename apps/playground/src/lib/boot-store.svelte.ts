// A module-level shared store (like @se/common/stores). The layout island writes it in onMount;
// a SEPARATE page island reads it. If both see the same instance (one shared chunk), the read flips
// to true after the layout mounts. If islands each bundle their own copy, it stays false — that is
// the "shared-store identity" caution, made observable.
export const bootStore = $state({ ready: false, navGuardHits: 0, pageViews: 0 });
