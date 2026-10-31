// Test stub for `virtual:ogygia/server-manifest` (the plugin's server-island table): no server islands.
export const load_islands = async (): Promise<{
	islands: Record<string, () => Promise<{ default: unknown }>>;
}> => ({ islands: {} });
export const island_url: Record<string, string> = {};
export const island_name: Record<string, string> = {};
export const island_render: Record<string, string> = {};
export const render_island: Record<string, string> = {};
export const island_reads_page_data: Record<string, boolean> | null = null;
