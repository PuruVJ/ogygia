// A "huge" mixed barrel — the shape a real design system ships: many component re-exports SIDE BY
// SIDE with plain config objects, utility functions and constants. This is exactly what the
// import-attribute form (`import X from '…' with { wake }`) can't island (default-only, one file per
// import). `import.meta.og.asRegion(Comp, timing)` marks any of these named component re-exports as a
// placed island, while the non-component exports stay ordinary values.
//
// Tree-shaking canaries live here too: `HeavyUnused` (a component) and `HUGE_UNUSED_CANARY` (a big
// string) are exported but never used on the test page. If barrel tree-shaking works, neither marker
// ends up in the Ticker/Flag island chunks.

// ── component re-exports (a .svelte default, re-exported under a name) ────────────────────────────
export { default as Ticker } from './Ticker.svelte';
export { default as Flag } from './Flag.svelte';
export { default as HeavyUnused } from './HeavyUnused.svelte';

// ── non-component exports mixed into the SAME barrel ──────────────────────────────────────────────
export const brandConfig = { name: 'Acme Islands', theme: 'dark' as const };

export function formatPrice(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

export type BrandTheme = (typeof brandConfig)['theme'];

// A big unique constant that nothing imports — the tree-shaking canary. Built from a repeated token
// so it is impossible to miss in a chunk grep, and impossible to collide with real code.
export const HUGE_UNUSED_CANARY =
	'ogygia_barrel_huge_unused_canary_' + 'Z9'.repeat(20000);
