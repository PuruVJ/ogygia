// @ogygia/federation's e2e suite: three real dev servers from examples/mfe (shell + cms + dash, booted
// by the `mfe` worker fixture in e2e/mfe.ts). `pnpm turbo run e2e --filter=@ogygia/federation`.
import { suite } from '@ogygia/tooling/e2e/config.ts';

export default suite({ port: 5190 });
