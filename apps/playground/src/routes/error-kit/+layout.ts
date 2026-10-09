// The layout says csr=true (the Kit default a real app's root layout usually leaves unset); the
// pages beneath opt OUT one by one. Kit renders an error page from the LAYOUT branch alone, so a
// 404 under one of those client-off pages is hydrated — e2e/error-kit.spec.ts.
export const csr = true;
