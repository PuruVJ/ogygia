// The consumer-reported shape: a csr=true LEAF at a deeply-nested (group) + [matcher] route
// under a csr=false layout with wake:'load' chrome. The layout's islands must degrade to plain
// inline components here — group segments are stripped and matcher segments kept verbatim on
// BOTH legs of the route-id comparison.
export const csr = true;
