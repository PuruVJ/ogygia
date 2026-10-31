// Prerendered page carrying an swr lake: real-PPR for the LAKE mint path. The lake's revalidate
// capability is baked into the static file at build — it must be long-lived (and the build must
// warn about the per-build signing key when OGYGIA_SECRET is unset).
export const prerender = true;
