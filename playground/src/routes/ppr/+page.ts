// Per-page opt-in: cache + replay this page's static shell, stream its defer holes fresh.
// ogygia strips this export before Kit sees it (Kit rejects unknown +page exports).
export const shell = 'cache';
