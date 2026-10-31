// @ogygia/testing's e2e suite: the package used the way an app's Playwright suite would, against the
// devtools lab's dev server (packages/devtools/e2e/app, booted by the spec).
// `pnpm turbo run e2e --filter=@ogygia/testing`.
import { suite } from '@ogygia/tooling/e2e/config.ts';

export default suite({ port: 3086 });
