// @ogygia/devtools' e2e suite (e2e/*.spec.ts) against the devtools lab (e2e/app): the dock on a dev
// server, the profiler on previews of the lab's build (built once here, before the specs), and an
// installed (packed) ogygia + devtools in dev. `pnpm turbo run e2e --filter=@ogygia/devtools`.
import { suite } from '@ogygia/tooling/e2e/config.ts';
import { fileURLToPath } from 'node:url';

export default suite({ port: 3052, build: fileURLToPath(new URL('./e2e/app', import.meta.url)) });
