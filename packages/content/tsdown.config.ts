import { library } from '@ogygia/tooling/tsdown';

export default library({
	// the content stack: installed with the plugin, resolved by the app at runtime
	external: [
		'mdsvex',
		'shiki',
		/^shiki\//,
		'@orama/orama',
		'bits-ui',
		'vite',
		/^@sveltejs\/vite-plugin-svelte/
	]
});
