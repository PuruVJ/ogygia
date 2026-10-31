// Tooling config for the package's own .svelte sources (tests, svelte-check, the language server):
// the docs chrome uses top-level `await`. Apps compile these components with their own config, and
// ogygia apps already run `compilerOptions.experimental.async`.
export default {
	compilerOptions: {
		experimental: { async: true }
	}
};
