/**
 * The pharos component barrel — every piece of chrome in one place. Each export is perfectly
 * tree-shakeable (import a brick, ship a brick); styling stays an explicit import
 * (`import 'ogygia/pharos/theme.css'` — skip it for zero CSS). Logic (outline, pharos, search,
 * dimensions, …) lives one level up; this directory is COMPONENTS ONLY.
 */
export { default as Frame } from './Frame.svelte';
export { default as Sidebar } from './Sidebar.svelte';
export { default as OnThisPage } from './OnThisPage.svelte';
export { default as Pager } from './Pager.svelte';
export { default as CodeChrome } from './CodeChrome.svelte';
export { default as SearchPage } from './SearchPage.svelte';
export { default as TabGroup } from './TabGroup.svelte';
export { default as Tab } from './Tab.svelte';
export { default as Doc } from './Doc.svelte';
export { default as BlogShell } from './BlogShell.svelte';
export { default as BlogList } from './BlogList.svelte';
export { default as BlogPost } from './BlogPost.svelte';
export { default as Link } from './Link.svelte';
export { default as Search } from './Search.svelte';
export { default as ThemeToggle } from './ThemeToggle.svelte';
export { default as Sheet } from './Sheet.svelte';
export { default as BottomBar } from './BottomBar.svelte';
export { default as Switcher } from './Switcher.svelte';
export { default as PharosSlot } from './PharosSlot.svelte';
// The roving-tabindex keyboard primitive behind every nav surface — reusable for custom nav.
export { roving } from './roving.js';
export type { RovingOptions } from './roving.js';
// Shell (and its bar) is deliberately NOT here: the batteries-included shell is its own export —
// `import Shell from 'ogygia/pharos/shell'`. The barrel holds the generic bricks (Frame = the
// headless, every-region-overridable composition you build a custom shell from).
