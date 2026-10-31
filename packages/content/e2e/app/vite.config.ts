import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { content } from '@ogygia/content/vite';
import { defineConfig } from 'vite';

// @ogygia/content's e2e fixture app: the markdown pipeline (stock defaults) so the `.svx` fixture
// behind /content-css compiles — that spec guards content-body scoped CSS shipping to a csr=false page.
export default defineConfig({
	plugins: [ogygia({ plugins: [content({ markdown: {} })] }), sveltekit()]
});
