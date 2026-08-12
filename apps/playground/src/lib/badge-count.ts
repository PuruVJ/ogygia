// Server-only counter behind a stable-address region (empty props → same frame address every render;
// content changes because it reads THIS state). The single-flight command bumps it and returns the
// re-rendered region in the mutation response — no extra fetch.
const g = globalThis as unknown as { __ogygia_badge__?: number };
g.__ogygia_badge__ ??= 0;
export const readBadgeCount = () => g.__ogygia_badge__ as number;
export const bumpBadgeCount = () => (g.__ogygia_badge__ = (g.__ogygia_badge__ as number) + 1);
