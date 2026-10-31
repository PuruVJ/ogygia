---
"@ogygia/tsdown-plugin-svelte": patch
---

Component types are emitted with `isolatedDeclarations` off, so a library that turns it on still gets its `.svelte.d.ts`; a new `tsconfig` option names the config to start from.
