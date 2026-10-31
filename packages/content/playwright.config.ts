// @ogygia/content's e2e suite against its fixture app (e2e/app), built and served.
// `pnpm turbo run e2e --filter=@ogygia/content`.
import { suite } from '@ogygia/tooling/e2e/config.ts';
import { fileURLToPath } from 'node:url';

export default suite({
	port: 3053,
	serve: fileURLToPath(new URL('./e2e/app', import.meta.url)),
	ready: '/content-css'
});
