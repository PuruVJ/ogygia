---
"ogygia": minor
---

**Breaking:** features move into plugin packages listed once in `ogygia({ plugins: [...] })`; flags are the first: `import { flag, decide } from '@ogygia/flags'` (was `ogygia/flag`), with `flags()` from `@ogygia/flags/vite` in the plugins.
