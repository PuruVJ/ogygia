// @ogygia/freeze's e2e suite: the scenario deck over a real build of the freeze fixture app (e2e/app)
// behind the edge emulators, and its dev leg. The specs build and boot the app themselves.
// `pnpm turbo run e2e --filter=@ogygia/freeze`.
import { suite } from '@ogygia/tooling/e2e/config.ts';

export default suite({ port: 3073 });
