// A plain barrel the registry imports from: its components reach the page node's client graph
// through a second module, which a scan of the registry's own imports would never see.
export { default as BlockPlainBarrel } from './BlockPlainBarrel.svelte';
