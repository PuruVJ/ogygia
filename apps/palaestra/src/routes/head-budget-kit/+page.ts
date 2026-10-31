// HEAD BUDGET, csr=true (e2e/head-budget-kit.spec.ts): the same registry page as /head-budget, on a
// route Kit hydrates. Kit must still hydrate the rendered islands inline (no runtime, no
// <ogygia-region>), and the page must link only what it rendered — not every registry block.
export const csr = true;
