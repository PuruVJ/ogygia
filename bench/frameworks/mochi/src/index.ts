import { Mochi, compress, silenceInternalRoutes } from 'mochi-framework';
import { compile as mdsvexCompile } from 'mdsvex';
import rehypeSlug from 'rehype-slug';

const PORT = Number(process.env.PORT) || 3335;

await Mochi.serve({
	port: PORT,
	development: process.env.MODE === 'development',
	handle: compress(),
	htmlShell: './src/shell.html',
	trailingSlash: 'never',
	filters: {
		'consoleLogger:line': silenceInternalRoutes
	},
	markdown: {
		compile: mdsvexCompile,
		rehypePlugins: [rehypeSlug]
	},
	routes: {
		'/': Mochi.page('./src/Home.svelte'),
		'/posts/small': Mochi.page('./src/posts/small.md'),
		'/posts/medium': Mochi.page('./src/posts/medium.md'),
		'/posts/large': Mochi.page('./src/posts/large.md')
	}
});

console.log('Server running at http://127.0.0.1:' + PORT);
