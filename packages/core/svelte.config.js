// Tooling config for the LIBRARY'S OWN .svelte sources (svelte-check / language server resolve the
// nearest svelte.config.js per file — without this, the pharos chrome's top-level `await` is
// flagged). Consumers compile these components in their app pipeline with their own config; ogygia
// apps already run `compilerOptions.experimental.async` (required for pharos chrome).
export default {
	compilerOptions: {
		experimental: { async: true }
	}
};
