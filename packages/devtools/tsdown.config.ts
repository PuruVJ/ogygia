import { library } from '@ogygia/tooling/tsdown';

export default library({
	// the dock's drag/resize and its props decoder: installed with the package, resolved by the app;
	// `pg`: the Postgres store's driver, the app's own (loaded only when that store is used)
	external: [/^@neodrag\/svelte(\/|$)/, 'devalue', 'pg']
});
