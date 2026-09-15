// Test stub for `virtual:ogygia/route-csr` — empty sets (no csr=true routes in unit tests). A suite
// that renders a csr=true document adds its route id to `csr_true_routes` (and deletes it after); a
// suite that renders an ERROR page under a csr=false page adds the id to `error_csr_true_routes`
// instead (Kit hydrates that error page from the layouts' csr). `root_layout_csr_true` is the
// routeless answer (no route matched → the root layout's csr).
export const csr_true_routes = new Set<string>();
export const error_csr_true_routes = new Set<string>();
export const root_layout_csr_true = false;
