// `ogygia` is the package apps install: every subpath re-exports the same subpath of `@ogygia/core`
// (one copy of each module: these files only forward). Plugins import `@ogygia/core` directly.
export * from '@ogygia/core';
