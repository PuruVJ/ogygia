// Tooling config for the package's own .svelte sources (tests, svelte-check, the language server).
// Apps compile these components with their own config, and ogygia apps already run
// `compilerOptions.experimental.async`.
export default {
	compilerOptions: {
		experimental: { async: true }
	}
};
