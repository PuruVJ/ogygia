export type TocItem = { id: string; label: string; sub: boolean };

/** Docs home section anchors — used by the floating side nav. */
export const docsTocItems: TocItem[] = [
	{ id: 'features', label: 'Features', sub: false },
	{ id: 'what', label: 'What it does', sub: false },
	{ id: 'map', label: 'The words', sub: false },
	{ id: 'install', label: 'Install', sub: false },
	{ id: 'adoption', label: 'Adoption', sub: false },
	{ id: 'adoption-one-route', label: 'One route at a time', sub: true },
	{ id: 'adoption-router', label: 'Root router', sub: true },
	{ id: 'adoption-mixed', label: 'Islands on Kit pages', sub: true },
	{ id: 'adoption-end', label: 'All-islands apps', sub: true },
	{ id: 'plugin', label: 'Plugin config', sub: false },
	{ id: 'plugin-visible', label: 'visible', sub: true },
	{ id: 'plugin-presets', label: 'presets', sub: true },
	{ id: 'plugin-importKeys', label: 'importKeys', sub: true },
	{ id: 'plugin-rate', label: 'rateLimit', sub: true },
	{ id: 'plugin-session', label: 'sessionCookie', sub: true },
	{ id: 'plugin-ttl', label: 'regionTtl', sub: true },
	{ id: 'plugin-secret', label: 'OGYGIA_SECRET', sub: true },
	{ id: 'authoring', label: 'Authoring', sub: false },
	{ id: 'boundary', label: 'OgygiaBoundary', sub: true },
	{ id: 'strategies', label: 'Strategies', sub: false },
	{ id: 'client-load', label: "hydrate: 'load'", sub: true },
	{ id: 'client-idle', label: "hydrate: 'idle'", sub: true },
	{ id: 'client-visible', label: "hydrate: 'visible'", sub: true },
	{ id: 'client-media', label: 'hydrate: media', sub: true },
	{ id: 'server-islands', label: 'Server islands', sub: false },
	{ id: 'server-load', label: "defer: 'load'", sub: true },
	{ id: 'server-idle', label: "defer: 'idle'", sub: true },
	{ id: 'server-visible', label: "defer: 'visible'", sub: true },
	{ id: 'server-media', label: 'defer: media', sub: true },
	{ id: 'lakes', label: 'Lakes', sub: false },
	{ id: 'remount', label: 'Remount', sub: true },
	{ id: 'data', label: 'Data & remotes', sub: false },
	{ id: 'router', label: 'SPA router', sub: false },
	{ id: 'persist', label: 'Persistence', sub: true },
	{ id: 'hmr', label: 'Dev HMR', sub: false },
	{ id: 'patterns', label: 'Pesky patterns', sub: false },
	{ id: 'constraints', label: 'Constraints', sub: false }
];

export const playgroundLinks = [
	{ href: '/playground', label: 'Overview' },
	{ href: '/playground/strategies', label: 'Strategies' },
	{ href: '/playground/server-islands', label: 'Server islands' },
	{ href: '/playground/lakes', label: 'Lakes' },
	{ href: '/playground/data', label: 'Data & remotes' },
	{ href: '/playground/router', label: 'Router' },
	{ href: '/playground/on-demand', label: 'Client-only lazy mount' },
	{ href: '/playground/mutation-guard', label: 'Mutation guard' }
] as const;
