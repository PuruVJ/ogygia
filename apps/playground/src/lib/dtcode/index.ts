// PLANTED barrel the island imports whole: it re-exports eight modules AND runs a statement of its
// own, so the barrel rewrite rightly leaves it (a barrel with side effects is not a pure re-export),
// and every module behind it rides into the island that imports one name from it.
export { default as Icons } from './Icons.svelte';
export { default as Chip } from './Chip.svelte';
export { default as ChipA } from './parts/ChipA.svelte';
export { default as ChipB } from './parts/ChipB.svelte';
export { default as ChipC } from './parts/ChipC.svelte';
export { default as ChipD } from './parts/ChipD.svelte';
export { default as ChipE } from './parts/ChipE.svelte';
export { default as ChipF } from './parts/ChipF.svelte';

(globalThis as { __dtcode_barrel?: boolean }).__dtcode_barrel = true;
