// @ogygia/router's e2e suite against its fixture app (e2e/app), built and served.
// `pnpm turbo run e2e --filter=@ogygia/router`.
import { suite } from '@ogygia/tooling/e2e/config.ts';
import { fileURLToPath } from 'node:url';

export default suite({
	port: 3054,
	serve: fileURLToPath(new URL('./e2e/app', import.meta.url)),
	ready: '/rtr/'
});
