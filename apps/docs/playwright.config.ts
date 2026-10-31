// The docs app's e2e suite: dev HMR under csr=false, on the docs app itself (the specs boot its
// `vite dev` on 5174). `pnpm turbo run e2e --filter=docs`.
import { suite } from '@ogygia/tooling/e2e/config.ts';

export default suite({ port: 5174 });
